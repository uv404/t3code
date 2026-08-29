import {
  EnvironmentId,
  NativeSessionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type ImportNativeSessionResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createNativeSessionEnvironmentAtoms } from "./nativeSessions.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const IMPORT_RESULT: ImportNativeSessionResult = {
  threadId: ThreadId.make("thread-imported"),
  created: true,
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function makeHarness(client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  return Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(connectionState);
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state,
      session: yield* SubscriptionRef.make(Option.some(session(client))),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
      _environmentId,
      effect,
    ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    );
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
      Effect.sync(() => value.dispose()),
    );
    return { atoms: createNativeSessionEnvironmentAtoms(runtime), registry };
  });
}

describe("native session environment atoms", () => {
  it.effect("imports serially per environment and preserves typed failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = {
        [WS_METHODS.nativeSessionsImport]: () => {
          attempts += 1;
          return attempts === 1
            ? Effect.succeed(IMPORT_RESULT)
            : Effect.fail(
                new EnvironmentRpcUnavailableError({
                  environmentId: TARGET.environmentId,
                  message: "import failed",
                }),
              );
        },
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(client);
      const input = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        nativeId: NativeSessionId.make("native-1"),
        projectId: ProjectId.make("project-1"),
      };

      const imported = yield* Effect.promise(() =>
        harness.atoms.import.run(harness.registry, {
          environmentId: TARGET.environmentId,
          input,
        }),
      );
      const failed = yield* Effect.promise(() =>
        harness.atoms.import.run(harness.registry, {
          environmentId: TARGET.environmentId,
          input,
        }),
      );

      expect(AsyncResult.isSuccess(imported)).toBe(true);
      expect(AsyncResult.isFailure(failed)).toBe(true);
      expect(attempts).toBe(2);
    }),
  );
});
