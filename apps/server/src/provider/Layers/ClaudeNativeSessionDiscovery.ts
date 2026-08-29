/**
 * ClaudeNativeSessionDiscovery - enumerate Claude Code sessions T3 did not start.
 *
 * Claude Code has no app-server listing endpoint, so discovery reads the
 * transcript directory the CLI already maintains: one `<sessionId>.jsonl` per
 * session, nested under a per-working-directory folder.
 *
 * Strictly read-only. Nothing here creates, rewrites, or deletes a transcript.
 *
 * @module ClaudeNativeSessionDiscovery
 */
import {
  NativeSessionId,
  type DiscoverNativeSessionsInput,
  type NativeSessionPage,
  type NativeSessionSummary,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const DEFAULT_DISCOVERY_LIMIT = 25;
const TRANSCRIPT_EXTENSION = ".jsonl";

export interface ClaudeNativeSessionDiscoveryOptions {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  /** Resolved Claude config dir (`CLAUDE_CONFIG_DIR` or `~`). */
  readonly homePath: string;
}

/**
 * Claude's config dir is the home itself when overridden, but a default install
 * nests transcripts under `~/.claude/projects`. Probe both — same rule
 * `UsageService` applies when scanning transcripts for usage.
 */
export const resolveClaudeTranscriptDir = Effect.fn("resolveClaudeTranscriptDir")(function* (
  homePath: string,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const nested = path.join(homePath, ".claude", "projects");
  const nestedExists = yield* fileSystem.exists(nested).pipe(Effect.orElseSucceed(() => false));
  return nestedExists ? nested : path.join(homePath, "projects");
});

/**
 * Claude names each transcript folder after the session's working directory
 * with separators replaced by `-`.
 *
 * The encoding is lossy — `/a/b-c` and `/a/b/c` collapse to the same folder —
 * so this is only ever a fast path for choosing which folder to read. The `cwd`
 * recorded inside each transcript is the authority, and
 * {@link readTranscriptSummary} re-checks it.
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll("\\", "-");
}

interface TranscriptFacts {
  readonly cwd: string | undefined;
  readonly title: string | undefined;
  readonly createdAt: string | undefined;
  readonly entrypoint: string | undefined;
  readonly messageCount: number;
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts the few fields a session picker needs from a transcript.
 *
 * Malformed lines are skipped rather than failing the scan: a transcript being
 * appended to by a live CLI can legitimately end mid-write, and one torn line
 * should not hide an otherwise resumable session.
 */
export function parseTranscriptFacts(contents: string): TranscriptFacts {
  let cwd: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let firstUserText: string | undefined;
  let createdAt: string | undefined;
  let entrypoint: string | undefined;
  let messageCount = 0;

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry["type"];
    cwd ??= textOf(entry["cwd"]);
    entrypoint ??= textOf(entry["entrypoint"]);
    createdAt ??= textOf(entry["timestamp"]);

    // Later titles supersede earlier ones: Claude re-titles as a session grows.
    if (type === "ai-title") aiTitle = textOf(entry["aiTitle"]) ?? aiTitle;
    if (type === "last-prompt") lastPrompt = textOf(entry["lastPrompt"]) ?? lastPrompt;

    if (type === "user" || type === "assistant") {
      messageCount += 1;
      if (type === "user" && firstUserText === undefined && entry["isMeta"] !== true) {
        firstUserText = readMessageText(entry["message"]);
      }
    }
  }

  return {
    cwd,
    title: aiTitle ?? lastPrompt ?? firstUserText,
    createdAt,
    entrypoint,
    messageCount,
  };
}

/** Claude message content is either a plain string or a content-block array. */
function readMessageText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return textOf(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text") {
      const text = textOf(record.text);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Enumerates Claude transcripts, newest first.
 *
 * Pagination is an offset into the modification-time ordering, carried as a
 * numeric cursor. Transcripts are stat-ed before they are read so only the
 * requested page pays the cost of parsing.
 */
export const discoverClaudeNativeSessions = (
  options: ClaudeNativeSessionDiscoveryOptions,
  input: DiscoverNativeSessionsInput,
): Effect.Effect<NativeSessionPage, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* resolveClaudeTranscriptDir(options.homePath);

    const rootExists = yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false));
    if (!rootExists) return { sessions: [] } satisfies NativeSessionPage;

    // With a cwd filter, read only the folder Claude would have used. Without
    // one, every project folder is in scope.
    const projectDirs = input.cwd
      ? [path.join(root, encodeClaudeProjectDirName(input.cwd))]
      : (yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []))).map((entry) =>
          path.join(root, entry),
        );

    const candidates: Array<{ readonly file: string; readonly modifiedAtMillis: number }> = [];
    for (const dir of projectDirs) {
      const entries = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (!entry.endsWith(TRANSCRIPT_EXTENSION)) continue;
        const file = path.join(dir, entry);
        const stat = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(stat)) continue;
        candidates.push({
          file,
          modifiedAtMillis: Option.match(stat.value.mtime, {
            onNone: () => 0,
            onSome: (mtime) => mtime.getTime(),
          }),
        });
      }
    }

    candidates.sort((left, right) => right.modifiedAtMillis - left.modifiedAtMillis);

    const offset = readCursorOffset(input.cursor);
    const limit = input.limit ?? DEFAULT_DISCOVERY_LIMIT;
    const page = candidates.slice(offset, offset + limit);

    const sessions: Array<NativeSessionSummary> = [];
    for (const candidate of page) {
      const contents = yield* fileSystem
        .readFileString(candidate.file)
        .pipe(Effect.orElseSucceed(() => ""));
      if (contents.length === 0) continue;

      const facts = parseTranscriptFacts(contents);
      // The folder-name encoding is ambiguous, so confirm against the cwd the
      // transcript itself recorded before claiming this session belongs here.
      if (input.cwd && facts.cwd !== undefined && facts.cwd !== input.cwd) continue;

      const sessionId = path.basename(candidate.file, TRANSCRIPT_EXTENSION);
      if (sessionId.length === 0) continue;

      const lastActiveAt = Option.match(DateTime.make(candidate.modifiedAtMillis), {
        onNone: () => undefined,
        onSome: DateTime.formatIso,
      });

      sessions.push({
        provider: options.provider,
        ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
        nativeId: NativeSessionId.make(sessionId),
        ...(facts.title ? { title: facts.title } : {}),
        ...(facts.cwd ? { cwd: facts.cwd } : {}),
        source: facts.entrypoint === "cli" ? "cli" : "unknown",
        // Claude leaves no on-disk marker for "a CLI currently holds this
        // session", so liveness cannot be determined here. Reported as
        // `unknown` rather than `notLoaded`, which would claim a safety this
        // scan cannot establish; the import path is what must decide whether an
        // undeterminable session may be adopted.
        activity: "unknown",
        ...(facts.createdAt ? { createdAt: facts.createdAt } : {}),
        ...(lastActiveAt ? { lastActiveAt } : {}),
        messageCount: facts.messageCount,
        // Matches `readClaudeResumeState`. `resumeSessionAt` is deliberately
        // omitted: it names an assistant message uuid to fork at, and adopting
        // a session should continue from its tip.
        resumeCursor: { resume: sessionId },
      });
    }

    const nextOffset = offset + page.length;
    return {
      sessions,
      ...(nextOffset < candidates.length ? { nextCursor: String(nextOffset) } : {}),
    } satisfies NativeSessionPage;
  });

function readCursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
