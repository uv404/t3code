// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  discoverClaudeNativeSessions,
  encodeClaudeProjectDirName,
  parseTranscriptFacts,
} from "./ClaudeNativeSessionDiscovery.ts";

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claudeAgent");

const options = { provider: PROVIDER, providerInstanceId: INSTANCE };

/** Mirrors the real transcript layout: `<home>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. */
function writeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  lines: ReadonlyArray<unknown>,
) {
  const dir = NodePath.join(home, ".claude", "projects", encodeClaudeProjectDirName(cwd));
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
}

function makeHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-discovery-"));
}

it("prefers the ai-title over the last prompt when naming a session", () => {
  const facts = parseTranscriptFacts(
    [
      JSON.stringify({ type: "user", cwd: "/w", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "raw prompt text" }),
      JSON.stringify({ type: "ai-title", aiTitle: "Generated title" }),
    ].join("\n"),
  );

  assert.strictEqual(facts.title, "Generated title");
  assert.strictEqual(facts.cwd, "/w");
});

it("skips torn lines rather than losing the whole transcript", () => {
  // A live CLI appending to a transcript can leave a partial final line.
  const facts = parseTranscriptFacts(
    [
      JSON.stringify({ type: "user", cwd: "/w", entrypoint: "cli", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: "hello" } }),
      '{"type":"assistant","message":{"cont',
    ].join("\n"),
  );

  assert.strictEqual(facts.cwd, "/w");
  assert.strictEqual(facts.entrypoint, "cli");
  assert.strictEqual(facts.messageCount, 2);
});

it("reads the first text block out of structured message content", () => {
  const facts = parseTranscriptFacts(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "structured prompt" }] },
    }),
  );

  assert.strictEqual(facts.title, "structured prompt");
});

it("ignores meta turns when deriving a title", () => {
  const facts = parseTranscriptFacts(
    [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { content: "<local-command-caveat>" },
      }),
      JSON.stringify({ type: "user", message: { content: "the real prompt" } }),
    ].join("\n"),
  );

  assert.strictEqual(facts.title, "the real prompt");
});

it.effect("discovers a native session and mints a resume cursor for it", () =>
  Effect.gen(function* () {
    const home = makeHome();
    writeTranscript(home, "/home/dev/app", "11111111-1111-4111-8111-111111111111", [
      {
        type: "user",
        cwd: "/home/dev/app",
        entrypoint: "cli",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { content: "start" },
      },
      { type: "ai-title", aiTitle: "t3-explore" },
    ]);

    const page = yield* discoverClaudeNativeSessions({ ...options, homePath: home }, {});

    assert.strictEqual(page.sessions.length, 1);
    const session = page.sessions[0]!;
    assert.strictEqual(session.title, "t3-explore");
    assert.strictEqual(session.cwd, "/home/dev/app");
    assert.strictEqual(session.source, "cli");
    // Claude has no on-disk liveness marker, so the scan must report that it
    // cannot tell rather than the safe-looking `notLoaded`.
    assert.strictEqual(session.activity, "unknown");
    assert.strictEqual(String(session.nativeId), "11111111-1111-4111-8111-111111111111");
    // The cursor must be exactly what ClaudeAdapter's own resume parser accepts.
    assert.deepStrictEqual(session.resumeCursor, {
      resume: "11111111-1111-4111-8111-111111111111",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("scopes results to the requested working directory", () =>
  Effect.gen(function* () {
    const home = makeHome();
    writeTranscript(home, "/home/dev/app", "22222222-2222-4222-8222-222222222222", [
      { type: "user", cwd: "/home/dev/app", entrypoint: "cli", message: { content: "a" } },
    ]);
    writeTranscript(home, "/home/dev/other", "33333333-3333-4333-8333-333333333333", [
      { type: "user", cwd: "/home/dev/other", entrypoint: "cli", message: { content: "b" } },
    ]);

    const page = yield* discoverClaudeNativeSessions(
      { ...options, homePath: home },
      { cwd: "/home/dev/app" },
    );

    assert.deepStrictEqual(
      page.sessions.map((session) => String(session.nativeId)),
      ["22222222-2222-4222-8222-222222222222"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a folder-name collision using the cwd recorded in the transcript", () =>
  Effect.gen(function* () {
    // `/home/dev/a-b` and `/home/dev/a/b` both encode to `-home-dev-a-b`, so the
    // folder alone cannot decide membership.
    const home = makeHome();
    writeTranscript(home, "/home/dev/a/b", "44444444-4444-4444-8444-444444444444", [
      { type: "user", cwd: "/home/dev/a/b", entrypoint: "cli", message: { content: "wrong" } },
    ]);

    const page = yield* discoverClaudeNativeSessions(
      { ...options, homePath: home },
      { cwd: "/home/dev/a-b" },
    );

    assert.deepStrictEqual(page.sessions, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns an empty page when no transcript directory exists", () =>
  Effect.gen(function* () {
    const page = yield* discoverClaudeNativeSessions(
      { ...options, homePath: NodePath.join(makeHome(), "absent") },
      {},
    );

    assert.deepStrictEqual(page.sessions, []);
    assert.strictEqual(page.nextCursor, undefined);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("paginates through transcripts with a resumable cursor", () =>
  Effect.gen(function* () {
    const home = makeHome();
    for (const index of [1, 2, 3]) {
      writeTranscript(home, "/home/dev/app", `5555555${index}-5555-4555-8555-555555555555`, [
        {
          type: "user",
          cwd: "/home/dev/app",
          entrypoint: "cli",
          message: { content: `m${index}` },
        },
      ]);
    }

    const first = yield* discoverClaudeNativeSessions({ ...options, homePath: home }, { limit: 2 });
    assert.strictEqual(first.sessions.length, 2);
    assert.strictEqual(first.nextCursor, "2");

    const second = yield* discoverClaudeNativeSessions(
      { ...options, homePath: home },
      { limit: 2, cursor: first.nextCursor },
    );
    assert.strictEqual(second.sessions.length, 1);
    assert.strictEqual(second.nextCursor, undefined);

    // Pages must not overlap, or the picker would show duplicates.
    const ids = [...first.sessions, ...second.sessions].map((session) => String(session.nativeId));
    assert.strictEqual(new Set(ids).size, 3);
  }).pipe(Effect.provide(NodeServices.layer)),
);
