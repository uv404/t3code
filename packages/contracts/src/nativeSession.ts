/**
 * Native session discovery and import — provider-agnostic contract.
 *
 * A "native session" is one a provider's own CLI/harness created outside T3
 * (`codex` in a terminal, `claude` in a terminal, …). T3 cannot see these
 * through {@link ProviderAdapterShape.listSessions}, which reports only the
 * sessions the running adapter itself started.
 *
 * The contract below is deliberately free of provider-specific shapes. The one
 * field that would otherwise force per-provider branching — how to reattach to
 * the session — travels as an opaque `resumeCursor`, minted by the adapter in
 * whatever format that adapter already parses on `startSession`. Everything
 * above the adapter (service routing, orchestration, client runtime, UI) moves
 * the cursor around without inspecting it, so adding a sixth harness means
 * implementing one adapter method and nothing else.
 *
 * @module nativeSession
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NativeSessionId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Where the harness says the session came from, normalized across providers.
 *
 * `cli` is the case this feature exists for: a session started by a human in a
 * terminal. The rest are carried so the UI can label or filter them rather than
 * silently presenting an IDE or automation session as an interactive one.
 */
export const NativeSessionSource = Schema.Literals(["cli", "ide", "exec", "app", "unknown"]);
export type NativeSessionSource = typeof NativeSessionSource.Type;

/**
 * Whether the harness currently holds the session open.
 *
 * This is the discriminator that keeps two owners off one session: `running`
 * means some other process is mid-turn on it, so importing must not hand T3 a
 * second writer. `notLoaded` is the ordinary on-disk case that is safe to adopt.
 *
 * `unknown` is the load-bearing one. Some harnesses leave no on-disk trace of
 * whether a session is open — Claude writes no lock file or liveness marker —
 * so an adapter that cannot tell must say so rather than reporting `notLoaded`
 * and quietly implying "safe". Import treats `unknown` as refusable and makes
 * the caller acknowledge the risk, which is the only place the two-owners guard
 * can live for those providers.
 */
export const NativeSessionActivity = Schema.Literals([
  "notLoaded",
  "idle",
  "running",
  "unknown",
  "error",
]);
export type NativeSessionActivity = typeof NativeSessionActivity.Type;

/**
 * One native session as reported by its owning adapter.
 *
 * Every field except `nativeId`, `activity`, and `resumeCursor` is optional:
 * harnesses differ in what metadata they retain, and a session that is
 * resumable but poorly described is still worth showing.
 */
export const NativeSessionSummary = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  nativeId: NativeSessionId,
  /** Human-assigned name when the harness has one, else a derived preview. */
  title: Schema.optional(TrimmedNonEmptyString),
  /** Working directory the session ran in; drives project mapping on import. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  source: NativeSessionSource,
  activity: NativeSessionActivity,
  createdAt: Schema.optional(IsoDateTime),
  lastActiveAt: Schema.optional(IsoDateTime),
  messageCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Opaque, adapter-minted reattachment token.
   *
   * Shaped to whatever that adapter already accepts as
   * `ProviderSessionStartInput.resumeCursor`, so importing reuses the existing
   * resume path instead of introducing a second way to reattach. Nothing above
   * the adapter may interpret this.
   */
  resumeCursor: Schema.Unknown,
});
export type NativeSessionSummary = typeof NativeSessionSummary.Type;

/**
 * Whether a discovered session already corresponds to a T3 thread.
 *
 * Computed by the server, not the adapter: an adapter knows about harness
 * sessions and nothing about T3 orchestration threads. Carrying it alongside
 * the summary is what lets the UI show "Open" instead of a duplicate "Import".
 */
export const NativeSessionImportState = Schema.Union([
  Schema.TaggedStruct("notImported", {}),
  Schema.TaggedStruct("imported", { threadId: ThreadId }),
]);
export type NativeSessionImportState = typeof NativeSessionImportState.Type;

export const DiscoveredNativeSession = Schema.Struct({
  session: NativeSessionSummary,
  importState: NativeSessionImportState,
});
export type DiscoveredNativeSession = typeof DiscoveredNativeSession.Type;

/**
 * Discovery is read-only and must never mutate harness state on disk.
 */
export const DiscoverNativeSessionsInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Restrict to sessions whose working directory matches, for project scoping. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  searchTerm: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  /** Opaque pagination cursor from a previous page's `nextCursor`. */
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type DiscoverNativeSessionsInput = typeof DiscoverNativeSessionsInput.Type;

export const NativeSessionPage = Schema.Struct({
  sessions: Schema.Array(NativeSessionSummary),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
});
export type NativeSessionPage = typeof NativeSessionPage.Type;

/**
 * Service-level discovery result, aggregated across provider instances.
 *
 * Distinct from {@link DiscoverNativeSessionsResult} because import state is
 * not knowable here: `ProviderService` routes to adapters and has no view of
 * T3 orchestration threads.
 *
 * `nextCursor` is only populated when discovery targeted a single provider
 * instance. Cursors are minted by adapters and are not comparable across them,
 * so a fan-out page cannot express "continue from here" without inventing a
 * composite cursor that would silently skip results.
 */
export const NativeSessionDiscoveryPage = Schema.Struct({
  sessions: Schema.Array(NativeSessionSummary),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
  unsupportedProviders: Schema.Array(ProviderDriverKind),
});
export type NativeSessionDiscoveryPage = typeof NativeSessionDiscoveryPage.Type;

export const DiscoverNativeSessionsResult = Schema.Struct({
  sessions: Schema.Array(DiscoveredNativeSession),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
  /**
   * Providers that were skipped because their adapter declares
   * `nativeSessionDiscovery: "unsupported"`. Reported rather than dropped so a
   * short list reads as "these harnesses can't be searched" instead of "you
   * have no sessions".
   */
  unsupportedProviders: Schema.Array(ProviderDriverKind),
});
export type DiscoverNativeSessionsResult = typeof DiscoverNativeSessionsResult.Type;

export const ImportNativeSessionInput = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  nativeId: NativeSessionId,
  /**
   * Required: the session's `cwd` may map to no project, or to several. Making
   * the caller name the project turns a silent mis-binding into an explicit
   * choice.
   */
  projectId: ProjectId,
  /** Overrides the harness-supplied title when the user renames on import. */
  title: Schema.optional(TrimmedNonEmptyString),
  /**
   * Opt in to importing a session whose `activity` is `unknown`.
   *
   * Absent or false, such a session is refused with `sessionBusy`: the harness
   * cannot say whether a terminal still owns it, and adopting one that is open
   * elsewhere produces two writers on the same transcript. The flag exists so
   * that risk is taken by a user who was shown it, not by a default.
   */
  acknowledgeUnknownActivity: Schema.optional(Schema.Boolean),
});
export type ImportNativeSessionInput = typeof ImportNativeSessionInput.Type;

export const ImportNativeSessionResult = Schema.Struct({
  threadId: ThreadId,
  /** False when the session was already imported and the existing thread was returned. */
  created: Schema.Boolean,
});
export type ImportNativeSessionResult = typeof ImportNativeSessionResult.Type;

export class NativeSessionDiscoveryError extends Schema.TaggedErrorClass<NativeSessionDiscoveryError>()(
  "NativeSessionDiscoveryError",
  {
    message: TrimmedNonEmptyString,
    provider: Schema.optional(ProviderDriverKind),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class NativeSessionImportError extends Schema.TaggedErrorClass<NativeSessionImportError>()(
  "NativeSessionImportError",
  {
    message: TrimmedNonEmptyString,
    reason: Schema.Literals([
      "notFound",
      "unsupported",
      "sessionBusy",
      "projectMismatch",
      "failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
