// BL-225 stage 3 (ADR 0051, AGENTS.md §M): the writer moved to the shared `shared-video-localizations` module (the upload of a planned
// release package writes its translations by the same rules); BL-207's names stay here.
export { createLiveLocalizationsWriter, LIVE_LOCALIZATIONS_READ_BACK } from "@/lib/shared-video-localizations";
