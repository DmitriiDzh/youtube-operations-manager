import { randomBytes } from "node:crypto";
import { getDeviceSecrets } from "@/lib/device-secrets";
import { createMetaClient } from "@/lib/social-gateway";
import { createCrossPostingStore } from "./adapters/store";
import { createCrossPostingServices, type CrossPostingCore } from "./services";

// BL-252 (ADR 0068): the cross-posting module's public surface. ONE core per process on `globalThis` -- the connect states and
// the pending Page picks live in its memory, so every route bundle must reach the same one.
export * from "./contracts";
export { createCrossPostingServices, type CrossPostingCore, type CrossPostingDeps, type CrossPostingStore } from "./services";

const CORE_KEY = Symbol.for("youtube-operations-manager.cross-posting-core");

export function createCrossPostingCore(): CrossPostingCore {
  const g = globalThis as unknown as Record<symbol, CrossPostingCore | undefined>;
  if (!g[CORE_KEY]) {
    const secrets = getDeviceSecrets();
    g[CORE_KEY] = createCrossPostingServices({
      store: createCrossPostingStore(),
      appSecret: secrets.slot("meta_app"),
      sealer: { seal: (plaintext) => secrets.seal(plaintext) },
      meta: createMetaClient(),
      now: () => Date.now(),
      randomId: () => randomBytes(24).toString("base64url"),
    });
  }
  return g[CORE_KEY];
}
