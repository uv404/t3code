/**
 * NativeSessionImportLive - discovery annotation and import for native sessions.
 *
 * See {@link NativeSessionImportShape} for what this service is for. The
 * mechanics worth knowing before reading the code:
 *
 * - **The claim comes before the thread.** Import writes the provider binding
 *   (which carries `nativeSessionId`, unique per provider in SQL) before
 *   dispatching `thread.create`. Claiming first is what makes two concurrent
 *   imports of the same session resolve to one thread instead of two competing
 *   writers on one transcript. A claim whose thread never materialized is
 *   self-healing: the next import sees a claim pointing at no active thread and
 *   takes it over.
 * - **Resume is not re-implemented here.** The seeded binding carries the
 *   adapter's own `resumeCursor`, so the first turn on the imported thread takes
 *   the existing `ProviderService.startSession` path. For that fallback to fire,
 *   the binding's `providerInstanceId` must match the instance the thread's
 *   model selection routes to — hence both are taken from the discovered
 *   session rather than from the project's defaults.
 *
 * @module NativeSessionImportLive
 */
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  NativeSessionDiscoveryError,
  NativeSessionHistoryError,
  NativeSessionImportError,
  ThreadId,
  type DiscoveredNativeSession,
  type ImportNativeSessionInput,
  type NativeSessionActivity,
  type NativeSessionHistoryInput,
  type NativeSessionImportState,
  type NativeSessionSummary,
  type ProviderInstanceId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  NativeSessionImport,
  type NativeSessionImportShape,
} from "../Services/NativeSessionImport.ts";

/**
 * How many discovery pages a single import will walk looking for its session.
 *
 * Import addresses a session by id, but no harness this feature supports offers
 * a get-by-id: the only way in is the same recency-ordered listing the picker
 * uses. Sessions a user wants to adopt are recent, so page 1 answers virtually
 * every real import; the cap keeps a miss from walking a multi-year history.
 * Exhausting it is logged rather than silently reported as "not found".
 */
const MAX_LOOKUP_PAGES = 10;

/** Only a session no process holds is safe to adopt without an acknowledgement. */
function describeActivity(activity: NativeSessionActivity): string | undefined {
  switch (activity) {
    case "notLoaded":
      return undefined;
    case "idle":
      return "another process currently has this session loaded";
    case "running":
      return "this session is mid-turn under another process";
    case "error":
      return "this session is loaded in an errored state under another process";
    case "unknown":
      return "T3 cannot tell whether a terminal still has this session open";
  }
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  /**
   * Whether `candidate` is the project directory or lives inside it.
   *
   * Compared on resolved paths with a trailing separator so `/work/app-2` is
   * not read as being inside `/work/app`.
   */
  const isWithinWorkspace = (candidate: string, workspaceRoot: string): boolean => {
    const resolvedCandidate = pathService.resolve(candidate);
    const resolvedRoot = pathService.resolve(workspaceRoot);
    if (resolvedCandidate === resolvedRoot) return true;
    const prefix = resolvedRoot.endsWith(pathService.sep)
      ? resolvedRoot
      : `${resolvedRoot}${pathService.sep}`;
    return resolvedCandidate.startsWith(prefix);
  };

  const toDiscoveryError = (message: string) => (cause: unknown) =>
    new NativeSessionDiscoveryError({ message, cause });

  const toImportError =
    (message: string, reason: NativeSessionImportError["reason"] = "failed") =>
    (cause: unknown) =>
      new NativeSessionImportError({ message, reason, cause });

  const newUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(toImportError("Failed to generate an identifier for the imported thread.")),
  );

  /**
   * Resolve the thread that currently owns a native session, if any.
   *
   * A binding whose thread was deleted is not ownership: the claim is reported
   * as absent so the session can be adopted again, and the caller is told which
   * stale thread to release.
   */
  const resolveOwner = Effect.fn("resolveOwner")(function* (session: {
    readonly provider: NativeSessionSummary["provider"];
    readonly nativeId: NativeSessionSummary["nativeId"];
  }) {
    const binding = yield* directory.getBindingByNativeSession({
      provider: session.provider,
      nativeSessionId: session.nativeId,
    });
    if (Option.isNone(binding)) return { owner: undefined, staleThreadId: undefined } as const;

    const thread = yield* projection.getThreadShellById(binding.value.threadId);
    return Option.isSome(thread)
      ? ({ owner: binding.value.threadId, staleThreadId: undefined } as const)
      : ({ owner: undefined, staleThreadId: binding.value.threadId } as const);
  });

  const discover: NativeSessionImportShape["discover"] = Effect.fn("discoverNativeSessions")(
    function* (input) {
      const page = yield* providerService
        .discoverNativeSessions(input)
        .pipe(Effect.mapError(toDiscoveryError("Failed to discover native provider sessions.")));

      const sessions: Array<DiscoveredNativeSession> = [];
      for (const session of page.sessions) {
        const { owner } = yield* resolveOwner(session).pipe(
          Effect.mapError(
            toDiscoveryError(
              `Failed to resolve import state for native session '${session.nativeId}'.`,
            ),
          ),
        );
        const importState: NativeSessionImportState =
          owner === undefined ? { _tag: "notImported" } : { _tag: "imported", threadId: owner };
        sessions.push({ session, importState });
      }

      return {
        sessions,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        unsupportedProviders: page.unsupportedProviders,
      };
    },
  );

  /**
   * Walk discovery pages until the requested session turns up.
   *
   * Paging needs a single provider instance: cursors are minted per adapter and
   * are not comparable across a fan-out. Without one, only the first (merged)
   * page can be searched, which is why callers should pass through the
   * `providerInstanceId` the discovery result already gave them.
   */
  const findSession = Effect.fn("findNativeSession")(function* (input: ImportNativeSessionInput) {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_LOOKUP_PAGES; pageIndex += 1) {
      const page = yield* providerService
        .discoverNativeSessions({
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(cursor ? { cursor } : {}),
        })
        .pipe(
          Effect.mapError(
            toImportError(`Failed to look up native session '${input.nativeId}'.`, "failed"),
          ),
        );

      if (page.unsupportedProviders.includes(input.provider)) {
        return yield* new NativeSessionImportError({
          message: `Provider '${input.provider}' cannot enumerate sessions its CLI created, so there is nothing to import.`,
          reason: "unsupported",
        });
      }

      const match = page.sessions.find(
        (session) => session.provider === input.provider && session.nativeId === input.nativeId,
      );
      if (match) return match;

      if (!page.nextCursor || input.providerInstanceId === undefined) {
        return yield* new NativeSessionImportError({
          message: `No native ${input.provider} session with id '${input.nativeId}' was found.`,
          reason: "notFound",
        });
      }
      cursor = page.nextCursor;
    }

    yield* Effect.logWarning("native session import gave up paging discovery", {
      provider: input.provider,
      nativeId: input.nativeId,
      pagesSearched: MAX_LOOKUP_PAGES,
    });
    return yield* new NativeSessionImportError({
      message: `Native ${input.provider} session '${input.nativeId}' was not among the ${MAX_LOOKUP_PAGES} most recent pages of sessions.`,
      reason: "notFound",
    });
  });

  const importSession: NativeSessionImportShape["importSession"] = Effect.fn("importNativeSession")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "native_session.provider": input.provider,
        "native_session.id": input.nativeId,
        "native_session.project_id": input.projectId,
      });

      const project = yield* projection
        .getProjectShellById(input.projectId)
        .pipe(Effect.mapError(toImportError(`Failed to read project '${input.projectId}'.`)));
      if (Option.isNone(project)) {
        return yield* new NativeSessionImportError({
          message: `Project '${input.projectId}' does not exist, so there is nowhere to put the imported session.`,
          reason: "projectMismatch",
        });
      }

      const existing = yield* resolveOwner({
        provider: input.provider,
        nativeId: input.nativeId,
      }).pipe(Effect.mapError(toImportError("Failed to check whether this session was imported.")));
      if (existing.owner !== undefined) {
        return { threadId: existing.owner, created: false };
      }

      const session = yield* findSession(input);

      const activityIssue = describeActivity(session.activity);
      const acknowledged =
        session.activity === "unknown" && input.acknowledgeUnknownActivity === true;
      if (activityIssue !== undefined && !acknowledged) {
        return yield* new NativeSessionImportError({
          message: `Cannot import this session: ${activityIssue}. Importing it would give the same transcript two writers.`,
          reason: "sessionBusy",
        });
      }

      if (
        session.cwd !== undefined &&
        !isWithinWorkspace(session.cwd, project.value.workspaceRoot)
      ) {
        return yield* new NativeSessionImportError({
          message: `This session ran in '${session.cwd}', which is outside project '${project.value.title}' (${project.value.workspaceRoot}). Choose the project it belongs to.`,
          reason: "projectMismatch",
        });
      }

      const providerInstanceId: ProviderInstanceId | undefined =
        session.providerInstanceId ?? input.providerInstanceId;
      if (providerInstanceId === undefined) {
        return yield* new NativeSessionImportError({
          message: `Native ${input.provider} session '${input.nativeId}' was discovered without a provider instance, so the imported thread could not be routed back to it.`,
          reason: "failed",
        });
      }

      // Release a claim left behind by a thread that no longer exists. Doing it
      // only now — after every check that could reject the import — keeps a
      // refused import from disturbing stored state.
      if (existing.staleThreadId !== undefined) {
        yield* directory
          .upsert({
            threadId: existing.staleThreadId,
            provider: input.provider,
            providerInstanceId,
            nativeSessionId: null,
          })
          .pipe(
            Effect.mapError(
              toImportError(
                `Failed to release the import claim held by deleted thread '${existing.staleThreadId}'.`,
              ),
            ),
          );
      }

      const threadId = ThreadId.make(yield* newUuid);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const modelSelection = {
        instanceId: providerInstanceId,
        model: session.model ?? project.value.defaultModelSelection?.model ?? DEFAULT_MODEL,
      };

      // Claim before creating: the unique (provider, native session) index is what
      // actually serializes two concurrent imports, and it can only do that if the
      // claim is the first write.
      yield* directory
        .upsert({
          threadId,
          provider: input.provider,
          providerInstanceId,
          nativeSessionId: input.nativeId,
          // No provider process is running for this thread yet. `stopped` is also
          // what keeps the session reaper from treating the row as a leak.
          status: "stopped",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          // Opaque by contract: minted by the adapter, replayed to the adapter.
          resumeCursor: session.resumeCursor,
          ...(session.cwd !== undefined ? { runtimePayload: { cwd: session.cwd } } : {}),
        })
        .pipe(
          Effect.mapError(
            toImportError(
              `Failed to bind native session '${input.nativeId}' to a thread. It may have just been imported elsewhere.`,
            ),
          ),
        );

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:native-session-import:${yield* newUuid}`),
          threadId,
          projectId: input.projectId,
          title: input.title ?? session.title ?? `Imported ${input.provider} session`,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(
          // Leave no claim behind for a thread that was never created; otherwise
          // the session would look imported and be unreachable until the
          // self-heal path noticed.
          Effect.tapError(() =>
            directory
              .upsert({
                threadId,
                provider: input.provider,
                providerInstanceId,
                nativeSessionId: null,
              })
              .pipe(Effect.ignore),
          ),
          Effect.mapError(
            toImportError(`Failed to create a thread for native session '${input.nativeId}'.`),
          ),
        );

      yield* Effect.logInfo("imported native provider session", {
        provider: input.provider,
        providerInstanceId,
        nativeId: input.nativeId,
        threadId,
        projectId: input.projectId,
        activity: session.activity,
        acknowledgedUnknownActivity: acknowledged,
      });

      return { threadId: threadId as ThreadIdType, created: true };
    },
  );

  const history: NativeSessionImportShape["history"] = Effect.fn("readNativeSessionHistory")(
    function* (input: NativeSessionHistoryInput) {
      const binding = yield* directory.getBinding(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new NativeSessionHistoryError({
              message: `Failed to read the imported session binding for thread '${input.threadId}'.`,
              reason: "failed",
              cause,
            }),
        ),
      );
      if (Option.isNone(binding) || binding.value.nativeSessionId == null) {
        return yield* new NativeSessionHistoryError({
          message: "This thread is not an imported native session.",
          reason: "notFound",
        });
      }
      if (binding.value.providerInstanceId === undefined) {
        return yield* new NativeSessionHistoryError({
          message:
            "The imported session is missing its provider instance, so history cannot be read.",
          reason: "failed",
        });
      }
      if (providerService.readNativeSession === undefined) {
        return yield* new NativeSessionHistoryError({
          message: "This server cannot read provider-owned session history.",
          reason: "unsupported",
        });
      }
      return yield* providerService
        .readNativeSession({
          providerInstanceId: binding.value.providerInstanceId,
          nativeSessionId: binding.value.nativeSessionId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new NativeSessionHistoryError({
                message: cause.message,
                reason: "unsupported",
                cause,
              }),
          ),
        );
    },
  );

  return { discover, importSession, history } satisfies NativeSessionImportShape;
});

export const NativeSessionImportLive = Layer.effect(NativeSessionImport, make);
