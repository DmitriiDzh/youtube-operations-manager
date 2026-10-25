import { insertVideoEditAuditEvent } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createBackupCore } from "@/lib/backup";
import { createIdGenerator } from "@/lib/shared-domain";
import { sleep } from "@/lib/shared-async";
import { createWriteContextCore } from "@/lib/write-context";
import { createLiveLocalizationsYoutubeAdapter } from "./adapters/youtube-api";
import { createLiveLocalizationsWriter } from "./services";

// A video's per-language title/description writer, shared (AGENTS.md §M) by the two writers AGENTS.md §F authorizes for a video
// besides Batches: a live broadcast's translations (BL-207, ADR 0045) and an uploaded planned release package's (BL-225, ADR 0051).
// Identity, a fresh read, the video's own language never written, a backup, the video unchanged right before the write, the shared
// safe merge, Live writes immediately before the one `videos.update part=snippet,localizations`, read-back and audit. Which videos
// each caller may write is that caller's rule.

export type {
  ExpectedSnippet,
  FreshLiveVideo,
  LiveLocalizationEntry,
  LiveLocalizationsApplyInput,
  LiveLocalizationsApplyResult,
  LiveLocalizationsWriterDependencies,
} from "./contracts";
export { createLiveLocalizationsWriter, LIVE_LOCALIZATIONS_READ_BACK } from "./services";

/** The writer wired to its real adapters; `source` names the caller in the audit. */
export function createVideoLocalizationsWriterCore(source: "live_localizations" | "upload_localizations") {
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
    source,
  });
}

export type VideoLocalizationsWriter = ReturnType<typeof createVideoLocalizationsWriterCore>;
