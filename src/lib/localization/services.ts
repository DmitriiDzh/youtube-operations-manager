import {
  DomainError,
  mapUnknownError,
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
  manageTrackedLanguageInputSchema,
  parseWithSchema,
  videoLocalizationDetailInputSchema,
  videoLocalizationDetailOutputSchema,
} from "./schemas";
// Hard allowlist for this one entry point only (owner instruction, 2026-09-21) -- every other
// language-code-accepting entrypoint in this app (XLSX import, AI localization) still uses the
// looser `isValidLanguageCode` BCP-47-ish regex from `@/lib/changesets/diff`, unchanged.
import { isSupportedYoutubeLanguageCode } from "@/lib/youtube-supported-languages";

type ServiceDependencies = {
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
    getTargetLanguages(channelId: string): Promise<string[]>;
    setTargetLanguages(channelId: string, languages: string[]): Promise<void>;
  };
  xlsxBuilder: {
    buildWorkbook(args: {
      channel: StoredChannelRecord;
      videos: StoredVideoRecord[];
    }): Promise<{ buffer: Buffer; rowCount: number }>;
  };
};

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

async function requireChannel(deps: ServiceDependencies, channelId: string): Promise<StoredChannelRecord> {
  const channel = await deps.channelStore.getChannel(channelId);
  if (!channel) {
    throw new DomainError({
      code: "not_found",
      message: "Channel has not been synchronized yet",
      details: { channelId },
    });
  }
  return channel;
}

async function requireChannelAndVideos(
  deps: ServiceDependencies,
  channelId: string
): Promise<{ channel: StoredChannelRecord; videos: StoredVideoRecord[] }> {
  const channel = await requireChannel(deps, channelId);

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
        const trackedLanguages = await deps.channelStore.getTargetLanguages(channel.channelId);
        const realLanguages = collectChannelLanguages(videos);
        const languages = [...new Set([...trackedLanguages, ...realLanguages])].sort();

        const output = parseWithSchema(
          localizationOverviewOutputSchema,
          {
            channelId: channel.channelId,
            channelTitle: channel.title,
            languages,
            trackedLanguages,
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

    /** Adds a language to the channel's tracked list, so it appears as a Languages-tab column
     * even before any video has a real translation in it -- solves the "you can't propose a
     * translation into a language that doesn't already show up as a column" chicken-and-egg gap
     * (owner instruction, 2026-09-21, docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5).
     * Purely a local display preference -- never touches YouTube, never creates a Change/
     * ChangeSet. */
    async addTrackedLanguage(input: unknown): Promise<{ trackedLanguages: string[] }> {
      const parsedInput = parseWithSchema(manageTrackedLanguageInputSchema, input, "add tracked language input");
      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        // Hard allowlist (owner instruction, 2026-09-21: "Пользователь не может добавить язык,
        // которого не будет в этом списке") -- replaces the older, looser isValidLanguageCode
        // regex check for this one entry point. A language already real on the channel (like
        // this channel's own "en-US", absent from this list -- see the file's own doc comment)
        // still shows up via the trackedLanguages ∪ real-data union regardless of this gate; only
        // a brand-new, not-yet-used code typed here is affected.
        if (!isSupportedYoutubeLanguageCode(parsedInput.language)) {
          throw new DomainError({
            code: "validation_failed",
            message: `"${parsedInput.language}" is not in YouTube's supported language list`,
            details: { language: parsedInput.language },
          });
        }
        const current = await deps.channelStore.getTargetLanguages(channel.channelId);
        const next = current.includes(parsedInput.language) ? current : [...current, parsedInput.language].sort();
        await deps.channelStore.setTargetLanguages(channel.channelId, next);
        return { trackedLanguages: next };
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },

    /** Removes a language from the tracked list. **Not a deletion of any real translation** --
     * if the language still has a real localization on at least one video, `languages` (the
     * union computed above) still includes it and the column does not disappear; this only
     * matters for a language that was tracked but never actually translated. Real deletion is a
     * separate, safety-critical capability (see `docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md`
     * §7.2/E5's still-open Question 2) deliberately not built as part of this slice. */
    async removeTrackedLanguage(input: unknown): Promise<{ trackedLanguages: string[] }> {
      const parsedInput = parseWithSchema(manageTrackedLanguageInputSchema, input, "remove tracked language input");
      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const current = await deps.channelStore.getTargetLanguages(channel.channelId);
        const next = current.filter((l) => l !== parsedInput.language);
        await deps.channelStore.setTargetLanguages(channel.channelId, next);
        return { trackedLanguages: next };
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
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
