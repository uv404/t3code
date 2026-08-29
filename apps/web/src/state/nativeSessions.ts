import { createNativeSessionEnvironmentAtoms } from "@t3tools/client-runtime/state/native-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

export const nativeSessionEnvironment = createNativeSessionEnvironmentAtoms(connectionAtomRuntime);
