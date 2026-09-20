import {
  DomainError,
  isDomainError,
  type LocalizationExportResult,
  type LocalizationOverview,
  type LocalizationOverviewRow,
  type StoredChannelRecord,
  type StoredVideoRecord,
  type VideoLocalizationDetail,
} from "./contracts";
import {
  exportLocalizationsInputSchema,
  localizationOverviewInputSchema,
  localizationOverviewOutputSchema,
  parseWithSchema,
  videoLocalizationDetailInputSchema,
  videoLocalizationDetailOutputSchema,
} from "./schemas";

type ServiceDependencies = {
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
  };
  xlsxBuilder: {
    buildWorkbook(args: {
      channel: StoredChannelRecord;
      videos: StoredVideoRecord[];
    }): Promise<{ buffer: Buffer; rowCount: number }>;
  };
};

function mapUnknownError(error: unknown, fallbackCode: DomainError["code"]) {
  if (isDomainError(error)) return error;

  return new DomainError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

function computeOverviewRow(video: StoredVideoRecord, languages: string[]): LocalizationOverviewRow {
  const present = new Set(Object.keys(video.existingLocalizations));
  const presentLanguages = languages.filter((lang) => present.has(lang)).sort();
  const missingLanguages = languages.filter((lang) => !present.has(lang)).sort();

  return {
    videoId: video.videoId,
    title: video.title,
    thumbnailUrl: video.thumbnails.default?.url ?? Object.values(video.thumbnails)[0]?.url ?? null,
    publishedAt: video.publishedAt,
    defaultLanguage: video.defaultLanguage,
    presentLanguages,
    missingLanguages,
    status: missingLanguages.length === 0 && languages.length > 0 ? "complete" : "missing",
    lastSyncedAt: video.lastSyncedAt.toISOString(),
  };
}

function collectChannelLanguages(videos: StoredVideoRecord[]): string[] {
  const languages = new Set<string>();
  for (const video of videos) {
    for (const language of Object.keys(video.existingLocalizations)) {
      languages.add(language);
    }
  }
  return [...languages].sort();
}

async function requireChannelAndVideos(
  deps: ServiceDependencies,
  channelId: string
): Promise<{ channel: StoredChannelRecord; videos: StoredVideoRecord[] }> {
  const channel = await deps.channelStore.getChannel(channelId);
  if (!channel) {
    throw new DomainError({
      code: "not_found",
      message: "Channel has not been synchronized yet",
      details: { channelId },
    });
  }

  const videos = await deps.channelStore.listVideosByChannel(channelId);
  return { channel, videos };
}

export function createLocalizationServices(deps: ServiceDependencies) {
  return {
    async getLocalizationOverview(input: unknown): Promise<LocalizationOverview> {
      const parsedInput = parseWithSchema(
        localizationOverviewInputSchema,
        input,
        "localization overview input"
      );

      try {
        const { channel, videos } = await requireChannelAndVideos(deps, parsedInput.channelId);
        const languages = collectChannelLanguages(videos);

        const output = parseWithSchema(
          localizationOverviewOutputSchema,
          {
            channelId: channel.channelId,
            channelTitle: channel.title,
            languages,
            totalVideos: videos.length,
            videos: videos.map((video) => computeOverviewRow(video, languages)),
          },
          "localization overview output"
        );

        return output;
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async getVideoLocalizationDetail(input: unknown): Promise<VideoLocalizationDetail> {
      const parsedInput = parseWithSchema(
        videoLocalizationDetailInputSchema,
        input,
        "video localization detail input"
      );

      try {
        const videos = await deps.channelStore.listVideosByChannel(parsedInput.channelId);
        const video = videos.find((v) => v.videoId === parsedInput.videoId);

        if (!video) {
          throw new DomainError({
            code: "not_found",
            message: "Video not found in synchronized channel data",
            details: { channelId: parsedInput.channelId, videoId: parsedInput.videoId },
          });
        }

        const output = parseWithSchema(
          videoLocalizationDetailOutputSchema,
          {
            videoId: video.videoId,
            channelId: video.channelId,
            originalTitle: video.title,
            originalDescription: video.description,
            defaultLanguage: video.defaultLanguage,
            locales: Object.entries(video.existingLocalizations)
              .map(([language, value]) => ({
                language,
                remoteTitle: value.title,
                remoteDescription: value.description,
              }))
              .sort((a, b) => a.language.localeCompare(b.language)),
            lastSyncedAt: video.lastSyncedAt.toISOString(),
          },
          "video localization detail output"
        );

        return output;
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async exportLocalizations(input: unknown): Promise<LocalizationExportResult> {
      const parsedInput = parseWithSchema(
        exportLocalizationsInputSchema,
        input,
        "export localizations input"
      );

      try {
        const { channel, videos } = await requireChannelAndVideos(deps, parsedInput.channelId);

        const selectedVideos = parsedInput.videoIds
          ? videos.filter((video) => parsedInput.videoIds!.includes(video.videoId))
          : videos;

        if (parsedInput.videoIds && selectedVideos.length !== parsedInput.videoIds.length) {
          const foundIds = new Set(selectedVideos.map((v) => v.videoId));
          const missing = parsedInput.videoIds.filter((id) => !foundIds.has(id));
          throw new DomainError({
            code: "validation_failed",
            message: "Some requested video ids do not belong to this synchronized channel",
            details: { channelId: parsedInput.channelId, missingVideoIds: missing },
          });
        }

        const { buffer, rowCount } = await deps.xlsxBuilder.buildWorkbook({
          channel,
          videos: selectedVideos,
        });

        return {
          filename: `localizations-${channel.channelId}.xlsx`,
          buffer,
          videoCount: selectedVideos.length,
          rowCount,
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },
  };
}

export type LocalizationServices = ReturnType<typeof createLocalizationServices>;
