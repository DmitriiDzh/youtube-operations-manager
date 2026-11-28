import { getDeviceSecrets } from "@/lib/device-secrets";
import { getVidiqGateway } from "@/lib/vidiq-gateway";
import { createVidiqStore } from "./adapters/store";
import { createVidiqResearchServices, serialLock, type VidiqResearchServices } from "./services";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077 decision 7): the vidIQ research module's public surface. ONE core per process on `globalThis` (the MCP route,
// the Web routes and other bundles are separate module instances; the call lock and the gateway's list cache must be shared). It
// starts nothing in the background: every vidIQ call is an explicit request.
// ---------------------------------------------------------------------------

export * from "./contracts";
export { argsSha256, canonicalArgs, createVidiqResearchServices, serialLock, type VidiqResearchDeps, type VidiqResearchServices } from "./services";

const CORE_KEY = Symbol.for("youtube-operations-manager.vidiq-research-core");

function buildCore(): VidiqResearchServices {
  return createVidiqResearchServices({
    store: createVidiqStore(),
    secret: getDeviceSecrets().slot("vidiq"),
    gateway: getVidiqGateway(),
    clock: { now: () => new Date() },
    withLock: serialLock(),
    log: (line) => console.warn(line),
  });
}

export type VidiqResearchCore = VidiqResearchServices;

export function createVidiqResearchCore(): VidiqResearchCore {
  const holder = globalThis as unknown as Record<symbol, VidiqResearchCore | undefined>;
  return (holder[CORE_KEY] ??= buildCore());
}
