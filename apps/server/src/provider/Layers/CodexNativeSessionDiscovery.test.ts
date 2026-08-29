import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { toNativeSessionSummary } from "./CodexNativeSessionDiscovery.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex");
const options = { provider: PROVIDER, providerInstanceId: INSTANCE };

type CodexThread = EffectCodexSchema.V2ThreadListResponse__Thread;

function makeThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    cliVersion: "1.0.0",
    createdAt: 1_767_225_600,
    cwd: "/home/dev/app",
    ephemeral: false,
    id: "thread-abc",
    modelProvider: "openai",
    preview: "some first message",
    sessionId: "session-abc",
    source: "cli",
    status: { type: "notLoaded" },
    ...overrides,
  } as CodexThread;
}

it("mints a resume cursor the Codex runtime already accepts", () => {
  const summary = toNativeSessionSummary(makeThread({ id: "thread-xyz" }), options);

  // CodexResumeCursorSchema is exactly `{ threadId }` — adopting a native
  // thread must reuse `thread/resume` rather than a second reattachment path.
  assert.deepStrictEqual(summary.resumeCursor, { threadId: "thread-xyz" });
  assert.strictEqual(String(summary.nativeId), "thread-xyz");
});

it("prefers the user-assigned name over the derived preview", () => {
  const summary = toNativeSessionSummary(
    makeThread({ name: "t3-explore", preview: "derived snippet" }),
    options,
  );

  assert.strictEqual(summary.title, "t3-explore");
});

it("falls back to the preview when the thread is unnamed", () => {
  const summary = toNativeSessionSummary(
    makeThread({ name: null, preview: "derived snippet" }),
    options,
  );

  assert.strictEqual(summary.title, "derived snippet");
});

it("normalizes each Codex source kind", () => {
  const sources: ReadonlyArray<[CodexThread["source"], string]> = [
    ["cli", "cli"],
    ["vscode", "ide"],
    ["exec", "exec"],
    ["appServer", "app"],
    ["unknown", "unknown"],
    [{ custom: "anything" }, "unknown"],
  ];

  assert.deepStrictEqual(
    sources.map(([source]) => toNativeSessionSummary(makeThread({ source }), options).source),
    sources.map(([, expected]) => expected),
  );
});

it("treats a thread holding active flags as running, not adoptable", () => {
  const summary = toNativeSessionSummary(
    makeThread({
      status: { type: "active", activeFlags: [] } as unknown as CodexThread["status"],
    }),
    options,
  );

  assert.strictEqual(summary.activity, "running");
});

it("maps the remaining status kinds", () => {
  assert.deepStrictEqual(
    (["notLoaded", "idle", "systemError"] as const).map(
      (type) =>
        toNativeSessionSummary(makeThread({ status: { type } as CodexThread["status"] }), options)
          .activity,
    ),
    ["notLoaded", "idle", "error"],
  );
});

it("reads second-precision epochs as seconds and millisecond epochs as millis", () => {
  const seconds = toNativeSessionSummary(makeThread({ createdAt: 1_767_225_600 }), options);
  const millis = toNativeSessionSummary(makeThread({ createdAt: 1_767_225_600_000 }), options);

  assert.strictEqual(seconds.createdAt, millis.createdAt);
});

it("prefers recencyAt over createdAt for last activity", () => {
  const summary = toNativeSessionSummary(
    makeThread({ createdAt: 1_767_225_600, recencyAt: 1_767_312_000 }),
    options,
  );

  assert.notStrictEqual(summary.lastActiveAt, summary.createdAt);
});

it("falls back to createdAt when the thread has no recency stamp", () => {
  const summary = toNativeSessionSummary(makeThread({ recencyAt: null }), options);

  assert.strictEqual(summary.lastActiveAt, summary.createdAt);
});
