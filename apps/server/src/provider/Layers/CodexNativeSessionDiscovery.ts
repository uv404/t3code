/**
 * CodexNativeSessionDiscovery - enumerate Codex CLI sessions T3 did not start.
 *
 * `CodexAdapter.listSessions` reports only sessions the running adapter owns,
 * so a thread someone started with `codex` in a terminal is invisible to T3.
 * This module asks the Codex app-server for its own thread index instead.
 *
 * Discovery runs against a short-lived app-server process rather than an
 * existing session's connection: discovery must work when no Codex session is
 * running at all, which is the normal case when a user wants to adopt a thread
 * they left in a terminal.
 *
 * @module CodexNativeSessionDiscovery
 */
import {
  NativeSessionId,
  type NativeSessionHistory,
  type NativeSessionHistoryEntry,
  type DiscoverNativeSessionsInput,
  type NativeSessionActivity,
  type NativeSessionPage,
  type NativeSessionSource,
  type NativeSessionSummary,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

/** Codex's own default page size is unbounded enough to be worth capping. */
const DEFAULT_DISCOVERY_LIMIT = 50;

type CodexThread = EffectCodexSchema.V2ThreadListResponse__Thread;

export interface CodexNativeSessionDiscoveryOptions {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Working directory for the probe process itself, not a result filter. */
  readonly spawnCwd: string;
}

function toNativeHistoryEntries(
  turns: ReadonlyArray<EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]>,
): ReadonlyArray<NativeSessionHistoryEntry> {
  const entries: Array<NativeSessionHistoryEntry> = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = item.content
          .flatMap((content) => (content.type === "text" ? [content.text] : []))
          .join("\n")
          .trim();
        if (text.length > 0) {
          const createdAt = toIsoDateTime(turn.startedAt);
          entries.push({
            id: `${turn.id}:${item.id}`,
            role: "user",
            text,
            ...(createdAt ? { createdAt } : {}),
          });
        }
      } else if (item.type === "agentMessage" && item.text.trim().length > 0) {
        const createdAt = toIsoDateTime(turn.startedAt);
        entries.push({
          id: `${turn.id}:${item.id}`,
          role: "assistant",
          text: item.text,
          ...(createdAt ? { createdAt } : {}),
        });
      }
    }
  }
  return entries;
}

/**
 * Codex reports epoch timestamps as bare numbers without documenting the unit.
 * Values below this threshold cannot be milliseconds for any plausible date, so
 * they are seconds. Guessing wrong only mislabels a timestamp, but guessing
 * consistently keeps sort order stable.
 */
const EPOCH_SECONDS_CEILING = 1e12;

function toIsoDateTime(epoch: number | null | undefined): string | undefined {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch)) return undefined;
  const millis = epoch < EPOCH_SECONDS_CEILING ? epoch * 1000 : epoch;
  return Option.match(DateTime.make(millis), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  });
}

function toNativeSessionSource(source: CodexThread["source"]): NativeSessionSource {
  if (typeof source !== "string") {
    // `{ custom }` and `{ subAgent }` are structured sources; neither is a
    // human's terminal session, which is what this feature adopts.
    return "unknown";
  }
  switch (source) {
    case "cli":
      return "cli";
    case "vscode":
      return "ide";
    case "exec":
      return "exec";
    case "appServer":
      return "app";
    default:
      return "unknown";
  }
}

/**
 * `notLoaded` is the safe-to-adopt case: the thread exists on disk and no
 * process holds it. Anything with active flags is mid-turn under another owner.
 */
function toNativeSessionActivity(status: CodexThread["status"]): NativeSessionActivity {
  switch (status.type) {
    case "notLoaded":
      return "notLoaded";
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "running";
  }
}

function trimmedOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toNativeSessionSummary(
  thread: CodexThread,
  options: Pick<CodexNativeSessionDiscoveryOptions, "provider" | "providerInstanceId">,
): NativeSessionSummary {
  // `name` is the user-assigned label (`t3-explore`); `preview` is the derived
  // first-message snippet Codex falls back to in its own UI.
  const title = trimmedOrUndefined(thread.name) ?? trimmedOrUndefined(thread.preview);
  const cwd = trimmedOrUndefined(thread.cwd);
  const model = trimmedOrUndefined(thread.modelProvider);
  const createdAt = toIsoDateTime(thread.createdAt);
  const lastActiveAt = toIsoDateTime(thread.recencyAt) ?? createdAt;

  return {
    provider: options.provider,
    ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    nativeId: NativeSessionId.make(thread.id),
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    source: toNativeSessionSource(thread.source),
    activity: toNativeSessionActivity(thread.status),
    ...(createdAt ? { createdAt } : {}),
    ...(lastActiveAt ? { lastActiveAt } : {}),
    // Exactly the shape `CodexSessionRuntime` already accepts as a resume
    // cursor, so adopting a native thread reuses `thread/resume` rather than
    // introducing a second reattachment path.
    resumeCursor: { threadId: thread.id },
  };
}

/**
 * Runs `thread/list` against a throwaway app-server and maps the result.
 *
 * The process is scoped: it is torn down before this effect completes.
 */
export const discoverCodexNativeSessions = (
  options: CodexNativeSessionDiscoveryOptions,
  input: DiscoverNativeSessionsInput,
): Effect.Effect<
  NativeSessionPage,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.Scope;

      const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
      const env = {
        ...options.environment,
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      };
      const extendEnv = options.environment === undefined;
      const appServerArgs = codexSessionAppServerArgs(undefined, options.launchArgs);
      const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
        env,
        extendEnv,
      });

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: options.spawnCwd,
            env,
            extendEnv,
            forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new CodexErrors.CodexAppServerSpawnError({
                command: `${options.binaryPath} app-server`,
                cause,
              }),
          ),
        );

      const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
        Layer.build,
        Effect.provideService(Scope.Scope, scope),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );

      yield* client.request("initialize", buildCodexInitializeParams());

      const response = yield* client.request("thread/list", {
        limit: input.limit ?? DEFAULT_DISCOVERY_LIMIT,
        // Newest first: the session a user wants to adopt is almost always the
        // one they just left.
        sortKey: "recency_at",
        sortDirection: "desc",
        // Read-only guarantee. Omitting this lets Codex scan JSONL rollouts and
        // write back "repaired" thread metadata; discovery must not mutate
        // files the harness owns.
        useStateDbOnly: true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });

      const nextCursor = trimmedOrUndefined(response.nextCursor);

      return {
        sessions: response.data.map((thread) => toNativeSessionSummary(thread, options)),
        ...(nextCursor ? { nextCursor } : {}),
      } satisfies NativeSessionPage;
    }),
  );

/**
 * Read the human-facing portion of a Codex rollout without resuming it.
 * `thread/read` is intentionally used instead of `thread/resume`: it does not
 * claim the rollout's writer lock, so history remains available while the
 * original terminal still owns the session.
 */
export const readCodexNativeSessionHistory = (
  options: CodexNativeSessionDiscoveryOptions,
  nativeSessionId: NativeSessionId,
): Effect.Effect<
  NativeSessionHistory,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.Scope;
      const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
      const env = {
        ...options.environment,
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      };
      const extendEnv = options.environment === undefined;
      const appServerArgs = codexSessionAppServerArgs(undefined, options.launchArgs);
      const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
        env,
        extendEnv,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: options.spawnCwd,
            env,
            extendEnv,
            forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new CodexErrors.CodexAppServerSpawnError({
                command: `${options.binaryPath} app-server`,
                cause,
              }),
          ),
        );
      const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
        Layer.build,
        Effect.provideService(Scope.Scope, scope),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      const response = yield* client.request("thread/read", {
        threadId: String(nativeSessionId),
        includeTurns: true,
      });
      return {
        provider: options.provider,
        nativeId: nativeSessionId,
        entries: toNativeHistoryEntries(response.thread.turns),
      } satisfies NativeSessionHistory;
    }),
  );
