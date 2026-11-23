import { randomBytes } from "node:crypto";
import { getDeviceSecrets } from "@/lib/device-secrets";
import { getSocialPostingSettingsJson, setSocialPostingSettingsJson } from "@/lib/db";
import { createMetaClient } from "@/lib/social-gateway";
import { createSocialJobStore } from "./adapters/jobs";
import { createCrossPostingStore } from "./adapters/store";
import { createCrossPostingServices, type CrossPostingCore } from "./services";

// BL-252 (ADR 0068): the cross-posting module's public surface. ONE core per process on `globalThis` -- the connect states and
// the pending Page picks live in its memory, so every route bundle must reach the same one.
export * from "./contracts";
export { createCrossPostingServices, type CrossPostingCore, type CrossPostingDeps, type CrossPostingStore } from "./services";
export { createCrossPostRunner, ownerRetryPending, type PlannedCrossPost, type CrossPostRunner, type SocialJob } from "./runner";
export { parseCrossPostBlock, videoProblems, type CrossPostTarget, type CrossPostProblem } from "./cross-post-block";

const CORE_KEY = Symbol.for("youtube-operations-manager.cross-posting-core");

/** The switch «Публикация в соцсети» of this computer, read fresh before every mutating Meta call (off by default). */
export async function postingEnabled(): Promise<boolean> {
  const raw = await getSocialPostingSettingsJson().catch(() => null);
  try {
    return raw ? (JSON.parse(raw) as { enabled?: unknown }).enabled === true : false;
  } catch {
    return false;
  }
}

export { createSocialJobStore };

export function createCrossPostingCore(): CrossPostingCore {
  const g = globalThis as unknown as Record<symbol, CrossPostingCore | undefined>;
  if (!g[CORE_KEY]) {
    const secrets = getDeviceSecrets();
    g[CORE_KEY] = createCrossPostingServices({
      store: createCrossPostingStore(),
      appSecret: secrets.slot("meta_app"),
      sealer: { seal: (plaintext) => secrets.seal(plaintext), open: (payload) => secrets.open(payload) },
      meta: createMetaClient({ postingAllowed: postingEnabled }),
      settings: { read: () => getSocialPostingSettingsJson(), write: (json) => setSocialPostingSettingsJson(json) },
      jobs: createSocialJobStore(),
      now: () => Date.now(),
      randomId: () => randomBytes(24).toString("base64url"),
    });
  }
  return g[CORE_KEY];
}
