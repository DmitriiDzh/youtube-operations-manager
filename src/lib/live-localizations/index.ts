import { insertVideoEditAuditEvent } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createBackupCore } from "@/lib/backup";
import { createIdGenerator } from "@/lib/shared-domain";
import { sleep } from "@/lib/shared-async";
import { createWriteContextCore } from "@/lib/write-context";
import { createLiveLocalizationsYoutubeAdapter } from "./adapters/youtube-api";
import { createLiveLocalizationsWriter } from "./services";

export type { ExpectedSnippet, FreshLiveVideo, LiveLocalizationEntry, LiveLocalizationsApplyInput, LiveLocalizationsApplyResult, LiveLocalizationsWriterDependencies } from "./contracts";
export { createLiveLocalizationsWriter, LIVE_LOCALIZATIONS_READ_BACK } from "./services";

/**
 * BL-207 (ADR 0045): the live-broadcast translations writer wired to its real adapters. The app layer plugs it into live-streams
 * (`src/composition/live-stream-localizations.ts`); live-streams imports no other feature module (AGENTS.md §M). The audit goes
 * to the same per-video edit log as video-details' writes.
 */
export function createLiveLocalizationsCore() {
  return createLiveLocalizationsWriter({
    auth: { resolve: (args) => resolveGoogleCredentials(args as Parameters<typeof resolveGoogleCredentials>[0]) },
    writeContext: {
      assertWriteChannel: (args) => createWriteContextCore().assertWriteChannel(args as Parameters<ReturnType<typeof createWriteContextCore>["assertWriteChannel"]>[0]),
    },
    youtube: createLiveLocalizationsYoutubeAdapter(),
    backup: createBackupCore(),
    audit: { record: (args) => insertVideoEditAuditEvent(args) },
    sleep: (ms) => sleep(ms),
    newId: createIdGenerator(),
  });
}

export type LiveLocalizationsCore = ReturnType<typeof createLiveLocalizationsCore>;
