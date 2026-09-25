import { createDefaultLogger } from "@/lib/shared-logger";
import { createProtocolAdapterRegistry } from "./adapters/registry";
import { createAiConnectionCredentialStoreAdapter, createAiConnectionStoreAdapter, createIdGenerator } from "./adapters/store";
import { resolveEncryptionKeyFromEnv } from "./crypto";
import { createAiConnectionServices } from "./services";
import type { FetchLike } from "./adapters/openai-compatible";

// Global `fetch` is the ONLY place a real network call can enter this module in
// production wiring -- every other file in src/lib/ai-connections/** takes a fetch
// implementation as an explicit dependency, never referencing a bare global `fetch`
// itself, so tests can never reach a real host by omission (AC-CONN-14).
const productionFetch: FetchLike = (url, init) => fetch(url, init);

export function createAiConnectionCore() {
  return createAiConnectionServices({
    connectionStore: createAiConnectionStoreAdapter(),
    credentialStore: createAiConnectionCredentialStoreAdapter(),
    resolveEncryptionKey: resolveEncryptionKeyFromEnv,
    protocolAdapters: createProtocolAdapterRegistry({ fetchImpl: productionFetch }),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type AiConnectionCore = ReturnType<typeof createAiConnectionCore>;
