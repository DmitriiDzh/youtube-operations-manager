import ExcelJS from "exceljs";
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

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.alignment = { vertical: "middle" };
}

export function createXlsxBuilder() {
  return {
    async buildWorkbook(args: {
      channel: StoredChannelRecord;
      videos: StoredVideoRecord[];
    }): Promise<{ buffer: Buffer; rowCount: number }> {
      const workbook = new ExcelJS.Workbook();
      workbook.created = new Date();

      const videosSheet = workbook.addWorksheet("Videos", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      videosSheet.columns = [
        { header: "channel_id", key: "channel_id", width: 26 },
        { header: "channel_name", key: "channel_name", width: 24 },
        { header: "video_id", key: "video_id", width: 14 },
        { header: "youtube_url", key: "youtube_url", width: 40 },
        { header: "published_at", key: "published_at", width: 22 },
        { header: "default_language", key: "default_language", width: 16 },
        { header: "original_title", key: "original_title", width: 40 },
        { header: "original_description", key: "original_description", width: 60 },
      ];
      styleHeaderRow(videosSheet.getRow(1));
      videosSheet.autoFilter = { from: "A1", to: "H1" };

      for (const video of args.videos) {
        const row = videosSheet.addRow({
          channel_id: args.channel.channelId,
          channel_name: args.channel.title,
          video_id: video.videoId,
          youtube_url: youtubeUrl(video.videoId),
          published_at: video.publishedAt,
          default_language: video.defaultLanguage ?? "",
          original_title: video.title,
          original_description: video.description,
        });
        row.getCell("original_description").alignment = { wrapText: true, vertical: "top" };
      }

      const localizationsSheet = workbook.addWorksheet("Localizations", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      localizationsSheet.columns = [
        { header: "video_id", key: "video_id", width: 14 },
        { header: "language", key: "language", width: 12 },
        { header: "language_name", key: "language_name", width: 22 },
        { header: "title", key: "title", width: 40 },
        { header: "description", key: "description", width: 60 },
        { header: "remote_title", key: "remote_title", width: 40 },
        { header: "remote_description", key: "remote_description", width: 60 },
        { header: "status", key: "status", width: 12 },
      ];
      styleHeaderRow(localizationsSheet.getRow(1));
      localizationsSheet.autoFilter = { from: "A1", to: "H1" };

      const languages = collectLanguages(args.videos);
      let rowCount = 0;

      for (const video of args.videos) {
        for (const language of languages) {
          const existing = video.existingLocalizations[language];
          const row = localizationsSheet.addRow({
            video_id: video.videoId,
            language,
            language_name: getLanguageDisplayName(language),
            title: "",
            description: "",
            remote_title: existing?.title ?? "",
            remote_description: existing?.description ?? "",
            status: existing ? "Existing" : "Missing",
          });
          row.getCell("description").alignment = { wrapText: true, vertical: "top" };
          row.getCell("remote_description").alignment = { wrapText: true, vertical: "top" };
          rowCount += 1;
        }
      }

      // Meta sheet (Phase 4, additive): schema_version/exported_at/channel_id let the
      // Phase 4 importer verify a workbook was exported for the intended channel and
      // (informationally) how fresh it is. A workbook without this sheet (older
      // Phase 3 export) remains importable -- Phase 4 falls back to per-row
      // remote_title/remote_description as the conflict-detection baseline, which
      // has existed since the first Phase 3 export. See docs/ARCHITECTURE.md.
      const metaSheet = workbook.addWorksheet("Meta");
      metaSheet.columns = [
        { header: "key", key: "key", width: 18 },
        { header: "value", key: "value", width: 40 },
      ];
      styleHeaderRow(metaSheet.getRow(1));
      metaSheet.addRow({ key: "schema_version", value: "2" });
      metaSheet.addRow({ key: "exported_at", value: new Date().toISOString() });
      metaSheet.addRow({ key: "channel_id", value: args.channel.channelId });

      const arrayBuffer = await workbook.xlsx.writeBuffer();
      return { buffer: Buffer.from(arrayBuffer), rowCount };
    },
  };
}
