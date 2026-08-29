import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  NativeSessionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type DiscoverNativeSessionsInput,
  type NativeSessionActivity,
  type NativeSessionDiscoveryPage,
  type NativeSessionSummary,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { NativeSessionImport } from "../Services/NativeSessionImport.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { NativeSessionImportLive } from "./NativeSessionImport.ts";

const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ROOT = "/work/app";
const NATIVE_ID = NativeSessionId.make("native-1");

const unused = () => Effect.die("not used in this test");

function makeSummary(overrides?: Partial<NativeSessionSummary>): NativeSessionSummary {
  return {
    provider: CODEX,
    providerInstanceId: CODEX_INSTANCE,
    nativeId: NATIVE_ID,
    title: "t3-explore",
    cwd: WORKSPACE_ROOT,
    source: "cli",
    activity: "notLoaded" satisfies NativeSessionActivity,
    // Deliberately a shape only the adapter understands: the import path must
    // move it around without inspecting it.
    resumeCursor: { threadId: "codex-thread-1" },
    ...overrides,
  };
}

function makeProjectShell(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "app",
    workspaceRoot: WORKSPACE_ROOT,
    defaultModelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.6-sol" },
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeThreadShell(command: Extract<OrchestrationCommand, { type: "thread.create" }>) {
  return {
    id: command.threadId,
    projectId: command.projectId,
    title: command.title,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as OrchestrationThreadShell;
}

interface HarnessOptions {
  /** Discovery pages served in order; the last one repeats. */
  readonly pages?: ReadonlyArray<NativeSessionDiscoveryPage>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  /** Fails every `thread.create` dispatch, to exercise claim rollback. */
  readonly failThreadCreate?: boolean;
}

function makeHarness(options?: HarnessOptions) {
  const pages: ReadonlyArray<NativeSessionDiscoveryPage> = options?.pages ?? [
    { sessions: [makeSummary()], unsupportedProviders: [] },
  ];
  const projects = options?.projects ?? [makeProjectShell()];
  const threads = new Map<string, OrchestrationThreadShell>();
  const dispatched: Array<OrchestrationCommand> = [];
  const discoveryCalls: Array<DiscoverNativeSessionsInput> = [];

  const providerService = {
    startSession: unused,
    sendTurn: unused,
    interruptTurn: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    stopSession: unused,
    listSessions: () => Effect.succeed([]),
    getCapabilities: unused,
    getInstanceInfo: unused,
    rollbackConversation: unused,
    discoverNativeSessions: (input: DiscoverNativeSessionsInput) =>
      Effect.sync(() => {
        discoveryCalls.push(input);
        const index = Math.min(discoveryCalls.length - 1, pages.length - 1);
        return pages[index]!;
      }),
    streamEvents: Stream.empty,
  } as unknown as ProviderServiceShape;

  const projection = {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === projectId))),
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
    searchThreads: unused,
  } as unknown as typeof ProjectionSnapshotQuery.Service;

  const engine = {
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (options?.failThreadCreate === true && command.type === "thread.create") {
          return yield* Effect.fail(new Error("dispatch rejected") as never);
        }
        dispatched.push(command);
        if (command.type === "thread.create") {
          threads.set(command.threadId, makeThreadShell(command));
        }
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } as unknown as typeof OrchestrationEngineService.Service;

  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = NativeSessionImportLive.pipe(
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(runtimeRepositoryLayer),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projection)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, threads, dispatched, discoveryCalls };
}

const IMPORT_INPUT = {
  provider: CODEX,
  providerInstanceId: CODEX_INSTANCE,
  nativeId: NATIVE_ID,
  projectId: PROJECT_ID,
} as const;

it.effect("imports a native session as a thread bound to the adapter's resume cursor", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;
    const directory = yield* ProviderSessionDirectory;

    const result = yield* service.importSession(IMPORT_INPUT);

    assert.strictEqual(result.created, true);
    assert.strictEqual(harness.dispatched.length, 1);
    const created = harness.dispatched[0]!;
    assert.strictEqual(created.type, "thread.create");
    if (created.type !== "thread.create") return;
    assert.strictEqual(created.threadId, result.threadId);
    assert.strictEqual(created.title, "t3-explore");

    const binding = yield* directory.getBinding(result.threadId);
    assert.strictEqual(Option.isSome(binding), true);
    if (Option.isNone(binding)) return;
    // The two preconditions for `ProviderService.startSession` to fall back to
    // the persisted cursor: the cursor itself, and an instance id matching the
    // one the thread's model selection routes to.
    assert.deepStrictEqual(binding.value.resumeCursor, { threadId: "codex-thread-1" });
    assert.strictEqual(binding.value.providerInstanceId, CODEX_INSTANCE);
    assert.strictEqual(created.modelSelection.instanceId, CODEX_INSTANCE);
    assert.strictEqual(binding.value.nativeSessionId, NATIVE_ID);
    // No provider process exists yet, and `stopped` is what the reaper skips.
    assert.strictEqual(binding.value.status, "stopped");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("re-importing the same native session returns the existing thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const first = yield* service.importSession(IMPORT_INPUT);
    const second = yield* service.importSession(IMPORT_INPUT);

    assert.strictEqual(second.created, false);
    assert.strictEqual(second.threadId, first.threadId);
    // One thread, not two competing writers on one transcript.
    assert.strictEqual(harness.dispatched.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a session another process is running", () => {
  const harness = makeHarness({
    pages: [{ sessions: [makeSummary({ activity: "running" })], unsupportedProviders: [] }],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);

    assert.strictEqual(error.reason, "sessionBusy");
    assert.strictEqual(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a session whose liveness the harness cannot report", () => {
  const harness = makeHarness({
    pages: [{ sessions: [makeSummary({ activity: "unknown" })], unsupportedProviders: [] }],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    // Claude reports `unknown` for every session: without an acknowledgement
    // this is the only place the two-owners guard can be applied.
    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);
    assert.strictEqual(error.reason, "sessionBusy");

    const imported = yield* service.importSession({
      ...IMPORT_INPUT,
      acknowledgeUnknownActivity: true,
    });
    assert.strictEqual(imported.created, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("accepts a session in a subdirectory but rejects a sibling directory", () => {
  const harness = makeHarness({
    pages: [
      { sessions: [makeSummary({ cwd: "/work/app-2" })], unsupportedProviders: [] },
      { sessions: [makeSummary({ cwd: "/work/app/packages/api" })], unsupportedProviders: [] },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    // `/work/app-2` shares a string prefix with `/work/app` but is a different
    // project entirely.
    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);
    assert.strictEqual(error.reason, "projectMismatch");

    const imported = yield* service.importSession(IMPORT_INPUT);
    assert.strictEqual(imported.created, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports a project that does not exist as a mismatch", () => {
  const harness = makeHarness({ projects: [] });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);

    assert.strictEqual(error.reason, "projectMismatch");
    assert.strictEqual(harness.dispatched.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports a provider that cannot enumerate its own sessions as unsupported", () => {
  const harness = makeHarness({
    pages: [{ sessions: [], unsupportedProviders: [CODEX] }],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);

    assert.strictEqual(error.reason, "unsupported");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("pages discovery until the requested session appears", () => {
  const harness = makeHarness({
    pages: [
      {
        sessions: [makeSummary({ nativeId: NativeSessionId.make("other") })],
        nextCursor: "page-2",
        unsupportedProviders: [],
      },
      { sessions: [makeSummary()], unsupportedProviders: [] },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const result = yield* service.importSession(IMPORT_INPUT);

    assert.strictEqual(result.created, true);
    assert.strictEqual(harness.discoveryCalls.length, 2);
    assert.strictEqual(harness.discoveryCalls[1]?.cursor, "page-2");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports a session that discovery never lists as not found", () => {
  const harness = makeHarness({
    pages: [{ sessions: [], unsupportedProviders: [] }],
  });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const error = yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);

    assert.strictEqual(error.reason, "notFound");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("annotates discovery with the thread that already imported a session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const before = yield* service.discover({});
    assert.strictEqual(before.sessions[0]?.importState._tag, "notImported");

    const imported = yield* service.importSession(IMPORT_INPUT);

    const after = yield* service.discover({});
    const state = after.sessions[0]?.importState;
    assert.strictEqual(state?._tag, "imported");
    if (state?._tag !== "imported") return;
    assert.strictEqual(state.threadId, imported.threadId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("treats a claim held by a deleted thread as available again", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;

    const first = yield* service.importSession(IMPORT_INPUT);
    // Deleting a thread leaves its provider binding row behind, so the claim
    // must be judged by whether the thread still exists, not by its presence.
    harness.threads.delete(first.threadId);

    const rediscovered = yield* service.discover({});
    assert.strictEqual(rediscovered.sessions[0]?.importState._tag, "notImported");

    const second = yield* service.importSession(IMPORT_INPUT);
    assert.strictEqual(second.created, true);
    assert.notStrictEqual(second.threadId, first.threadId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("leaves no claim behind when the thread could not be created", () => {
  const harness = makeHarness({ failThreadCreate: true });
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;
    const directory = yield* ProviderSessionDirectory;

    yield* service.importSession(IMPORT_INPUT).pipe(Effect.flip);

    // A claim surviving a failed create would make the session look imported
    // while being unreachable.
    const claim = yield* directory.getBindingByNativeSession({
      provider: CODEX,
      nativeSessionId: NATIVE_ID,
    });
    assert.strictEqual(Option.isNone(claim), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps the import claim across an ordinary session lifecycle write", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* NativeSessionImport;
    const directory = yield* ProviderSessionDirectory;

    const imported = yield* service.importSession(IMPORT_INPUT);

    // What `ProviderService.upsertSessionBinding` writes when the first turn
    // starts a session. It says nothing about the native session, so the claim
    // must survive — otherwise re-import would fork the thread.
    yield* directory.upsert({
      threadId: imported.threadId,
      provider: CODEX,
      providerInstanceId: CODEX_INSTANCE,
      status: "running",
      runtimePayload: { cwd: WORKSPACE_ROOT, model: "gpt-5.6-sol" },
    });

    const claim = yield* directory.getBindingByNativeSession({
      provider: CODEX,
      nativeSessionId: NATIVE_ID,
    });
    assert.strictEqual(Option.isSome(claim), true);
    if (Option.isNone(claim)) return;
    assert.strictEqual(claim.value.threadId, imported.threadId);
    assert.deepStrictEqual(claim.value.resumeCursor, { threadId: "codex-thread-1" });
  }).pipe(Effect.provide(harness.layer));
});
