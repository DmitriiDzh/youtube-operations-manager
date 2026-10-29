import { randomUUID } from "node:crypto";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createVoiceFiles } from "./adapters/files";
import { createVoiceStore } from "./adapters/store";
import type { VoiceProvider, VoiceProviderPort } from "./contracts";
import { createVoiceRegistryServices, createVoiceResolver } from "./services";

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057): the channel voice registry's public surface. It imports no provider module (AGENTS.md §M): the
// providers are passed in by `src/composition/speech.ts`; the providers' own speech jobs use only `createVoiceResolverForProduction`.
// ---------------------------------------------------------------------------

export * from "./contracts";
export { createVoiceRegistryServices, createVoiceResolver, voiceView, type VoiceFilesPort, type VoiceRegistryDeps, type VoiceRegistryServices, type VoiceStore } from "./services";

/** The registry over the real database and the channel workspaces, with the providers the caller wires. */
export function createVoiceRegistryForProduction(providers: Partial<Record<VoiceProvider, VoiceProviderPort>>) {
  const workspaces = createChannelWorkspacesCore();
  return createVoiceRegistryServices({
    store: createVoiceStore(),
    files: createVoiceFiles(async (channelId) => workspaces.getWorkspace({ channelId })),
    providers,
    clock: { now: () => new Date() },
    generateId: () => randomUUID().replace(/-/g, "").slice(0, 20),
  });
}

/** Only the resolution of a speech job's voice (an APPROVED voice of that channel and provider), over the real database. */
export function createVoiceResolverForProduction() {
  return createVoiceResolver(createVoiceStore());
}
