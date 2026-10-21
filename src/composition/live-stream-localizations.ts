import { createLiveLocalizationsCore } from "@/lib/live-localizations";
import type { LocalizationsPort } from "@/lib/live-streams";

/**
 * BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 3, ADR 0045): the stream's translations writer, composed at the app layer next to
 * `live-stream-video-fields` -- live-streams imports no other feature module (AGENTS.md §M). Used by the live-stream routes
 * (Start, «Применить снова») and by the server's runner (BL-205 segment switches), so all three run the same step.
 */
export function createLiveStreamLocalizations(): LocalizationsPort {
  return {
    apply: (args) => createLiveLocalizationsCore().apply(args),
  };
}
