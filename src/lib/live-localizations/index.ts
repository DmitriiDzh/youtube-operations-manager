import { createVideoLocalizationsWriterCore } from "@/lib/shared-video-localizations";

export type { ExpectedSnippet, FreshLiveVideo, LiveLocalizationEntry, LiveLocalizationsApplyInput, LiveLocalizationsApplyResult, LiveLocalizationsWriterDependencies } from "./contracts";
export { createLiveLocalizationsWriter, LIVE_LOCALIZATIONS_READ_BACK } from "./services";

/**
 * BL-207 (ADR 0045): the live-broadcast translations writer wired to its real adapters. The app layer plugs it into live-streams
 * (`src/composition/live-stream-localizations.ts`); live-streams imports no other feature module (AGENTS.md §M). The audit goes
 * to the same per-video edit log as video-details' writes. Since BL-225 the writer itself lives in `shared-video-localizations`.
 */
export function createLiveLocalizationsCore() {
  return createVideoLocalizationsWriterCore("live_localizations");
}

export type LiveLocalizationsCore = ReturnType<typeof createLiveLocalizationsCore>;
