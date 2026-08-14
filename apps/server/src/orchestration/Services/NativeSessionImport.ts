/**
 * NativeSessionImport - adopt harness-owned sessions as T3 threads.
 *
 * A "native session" is one a provider's own CLI created outside T3. The
 * provider layer can enumerate them ({@link ProviderServiceShape.discoverNativeSessions})
 * but cannot say whether T3 already adopted one, because an adapter knows about
 * harness sessions and nothing about orchestration threads. This service is the
 * layer that holds both halves: it annotates discovery with import state, and it
 * performs the import itself.
 *
 * Import creates a thread and a provider binding carrying the adapter-minted
 * `resumeCursor`. It never copies a transcript: the harness keeps owning the
 * history, and the first turn on the imported thread flows through the ordinary
 * resume path with a cursor T3 did not originally mint.
 *
 * Nothing here inspects the cursor or branches on provider. Adding a sixth
 * harness means implementing one adapter method, not touching this file.
 *
 * @module NativeSessionImport
 */
import type {
  DiscoverNativeSessionsInput,
  DiscoverNativeSessionsResult,
  ImportNativeSessionInput,
  ImportNativeSessionResult,
  NativeSessionDiscoveryError,
  NativeSessionImportError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface NativeSessionImportShape {
  /**
   * Discover native sessions and annotate each with whether T3 already has it.
   *
   * Read-only end to end: neither the harness scan nor the import-state lookup
   * writes anything.
   */
  readonly discover: (
    input: DiscoverNativeSessionsInput,
  ) => Effect.Effect<DiscoverNativeSessionsResult, NativeSessionDiscoveryError>;

  /**
   * Adopt a native session as a T3 thread, idempotently.
   *
   * Re-importing the same `(provider, nativeId)` returns the existing thread
   * with `created: false` rather than producing a second thread that would
   * compete for the same transcript.
   */
  readonly importSession: (
    input: ImportNativeSessionInput,
  ) => Effect.Effect<ImportNativeSessionResult, NativeSessionImportError>;
}

export class NativeSessionImport extends Context.Service<
  NativeSessionImport,
  NativeSessionImportShape
>()("t3/orchestration/Services/NativeSessionImport") {}
