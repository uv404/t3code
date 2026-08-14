import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Environment-scoped native-session discovery and import commands.
 *
 * `resumeCursor` deliberately remains opaque here. The adapter owns its
 * shape, while callers only select a discovered session and pass its native
 * identity through the import contract.
 */
export function createNativeSessionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discover: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:native-sessions:discover",
      tag: WS_METHODS.nativeSessionsDiscover,
    }),
    import: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:native-sessions:import",
      tag: WS_METHODS.nativeSessionsImport,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
