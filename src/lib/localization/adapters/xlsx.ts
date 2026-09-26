import { buildWorkbook, workbookToBuffer, type XlsxSheetSpec } from "@/lib/shared-xlsx";
import type { StoredChannelRecord, StoredVideoRecord } from "../contracts";
import { getLanguageDisplayName } from "../languages";

function youtubeUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function collectLanguages(videos: StoredVideoRecord[]): string[] {
  const languages = new Set<string>();
  for (const video of videos) {
    for (const language of Object.keys(video.existingLocalizations)) {
      languages.add(language);
    }
  }
  return [...languages].sort();
}

export function createXlsxBuilder() {
  return {
    async buildWorkbook(args: {
      channel: StoredChannelRecord;
      videos: StoredVideoRecord[];
    }): Promise<{ buffer: Buffer; rowCount: number }> {
      const videosSheet: XlsxSheetSpec = {
        name: "Videos",
        columns: [
          { header: "channel_id", key: "channel_id", width: 26 },
          { header: "channel_name", key: "channel_name", width: 24 },
          { header: "video_id", key: "video_id", width: 14 },
          { header: "youtube_url", key: "youtube_url", width: 40 },
          { header: "published_at", key: "published_at", width: 22 },
          { header: "default_language", key: "default_language", width: 16 },
          { header: "original_title", key: "original_title", width: 40 },
          { header: "original_description", key: "original_description", width: 60 },
        ],
        freezeHeaderRow: true,
        autoFilter: true,
        wrapTextColumns: ["original_description"],
        rows: args.videos.map((video) => ({
          channel_id: args.channel.channelId,
          channel_name: args.channel.title,
          video_id: video.videoId,
          youtube_url: youtubeUrl(video.videoId),
          published_at: video.publishedAt,
          default_language: video.defaultLanguage ?? "",
          original_title: video.title,
          original_description: video.description,
        })),
      };

      const languages = collectLanguages(args.videos);
      const localizationRows: Array<Record<string, unknown>> = [];
      for (const video of args.videos) {
        for (const language of languages) {
          const existing = video.existingLocalizations[language];
          localizationRows.push({
            video_id: video.videoId,
            language,
            language_name: getLanguageDisplayName(language),
            title: "",
            description: "",
            remote_title: existing?.title ?? "",
            remote_description: existing?.description ?? "",
            status: existing ? "Existing" : "Missing",
          });
        }
      }

      const localizationsSheet: XlsxSheetSpec = {
        name: "Localizations",
        columns: [
          { header: "video_id", key: "video_id", width: 14 },
          { header: "language", key: "language", width: 12 },
          { header: "language_name", key: "language_name", width: 22 },
          { header: "title", key: "title", width: 40 },
          { header: "description", key: "description", width: 60 },
          { header: "remote_title", key: "remote_title", width: 40 },
          { header: "remote_description", key: "remote_description", width: 60 },
          { header: "status", key: "status", width: 12 },
        ],
        freezeHeaderRow: true,
        autoFilter: true,
        wrapTextColumns: ["description", "remote_description"],
        rows: localizationRows,
      };

      // Meta sheet (Phase 4, additive): schema_version/exported_at/channel_id let the
      // Phase 4 importer verify a workbook was exported for the intended channel and
      // (informationally) how fresh it is. A workbook without this sheet (older
      // Phase 3 export) remains importable -- Phase 4 falls back to per-row
      // remote_title/remote_description as the conflict-detection baseline, which
      // has existed since the first Phase 3 export. See docs/ARCHITECTURE.md.
      const metaSheet: XlsxSheetSpec = {
        name: "Meta",
        columns: [
          { header: "key", key: "key", width: 18 },
          { header: "value", key: "value", width: 40 },
        ],
        rows: [
          { key: "schema_version", value: "2" },
          { key: "exported_at", value: new Date().toISOString() },
          { key: "channel_id", value: args.channel.channelId },
        ],
      };

      const workbook = buildWorkbook([videosSheet, localizationsSheet, metaSheet]);
      const buffer = await workbookToBuffer(workbook);
      return { buffer, rowCount: localizationRows.length };
    },
  };
}
