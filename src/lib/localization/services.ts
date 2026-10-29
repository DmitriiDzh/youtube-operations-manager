import {
  DomainError,
  mapUnknownError,
  type LocalizationExportResult,
  type LocalizationOverview,
  type LocalizationOverviewRow,
  type LocalizationVersion,
  type StoredChannelRecord,
  type StoredVideoRecord,
  type TranslationAlerts,
  type VideoLocalizationDetail,
} from "./contracts";
import {
  channelOnlyInputSchema,
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
import { createHash } from "node:crypto";
import { missingTrackedLanguages, readAgainstBaseline, sameLanguage } from "@/lib/shared-language-baseline";

type ServiceDependencies = {
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
    getTargetLanguages(channelId: string): Promise<string[]>;
    setTargetLanguages(channelId: string, languages: string[]): Promise<void>;
    /** BL-178 part B: the language settings set differently on the owner's computers (optional; absent = none). */
    getConflictedLanguageSettings?(channelId: string): Promise<string[]>;
  };
  /** BL-178 (PROJECT_SPEC §14, 2026-10-12): the channel's language; optional (absent = every video read as it is). */
  channelLanguageBaseline?: {
    getExpectedDefaultLanguage(channelId: string): Promise<string | null>;
    /** Only the refresh fingerprint reads it (review item 3: an audio baseline from the other computer reloads the page too). */
    getExpectedDefaultAudioLanguage?(channelId: string): Promise<string | null>;
  };
  xlsxBuilder: {
    buildWorkbook(args: {
      channel: StoredChannelRecord;
      videos: StoredVideoRecord[];
    }): Promise<{ buffer: Buffer; rowCount: number }>;
  };
};

function computeOverviewRow(video: StoredVideoRecord, languages: string[], channelBaseline: string | null): LocalizationOverviewRow {
  // BL-178: with the channel's language set, a video whose own language differs is read as the baseline's original -- its
  // old-language entry is YouTube's mirror of the snippet, not a translation (`@/lib/shared-language-baseline`).
  const reading = readAgainstBaseline(
    { defaultLanguage: video.defaultLanguage, title: video.title, description: video.description, localizations: video.existingLocalizations },
    channelBaseline
  );
  // A video with no language of its own takes the channel's: that is what a Batch writes for it (2026-10-02 exception; review M6).
  const originalLanguage = reading.kind === "aligned" ? reading.to : (video.defaultLanguage ?? channelBaseline);
  const localizations = reading.kind === "aligned" ? reading.view.localizations : video.existingLocalizations;
  const present = new Set(Object.keys(localizations));
  const presentLanguages = languages.filter((lang) => present.has(lang)).sort();
  // The video's original language: YouTube takes no localization for it, so it is never "missing". If a real localization for that
  // code does exist it still counts as present above. Matching is by exact code (a default of `en-US` is not `en`).
  const missingLanguages = languages.filter((lang) => !present.has(lang) && lang !== originalLanguage).sort();

  return {
    videoId: video.videoId,
    title: video.title,
    thumbnailUrl: video.thumbnails.default?.url ?? Object.values(video.thumbnails)[0]?.url ?? null,
    publishedAt: video.publishedAt,
    privacyStatus: video.privacyStatus,
    publishAt: video.publishAt,
    defaultLanguage: video.defaultLanguage,
    originalLanguage,
    presentLanguages,
    missingLanguages,
    status: missingLanguages.length === 0 && languages.length > 0 ? "complete" : "missing",
    lastSyncedAt: video.lastSyncedAt.toISOString(),
  };
}

/**
 * BL-178 part C (§3.3 C2): the tracked languages this video lacks, read against the channel's language. The rule is the shared
 * `missingTrackedLanguages` (`@/lib/shared-language-baseline`, BL-235: the publishing coverage uses it too).
 */
export function missingTrackedTranslations(video: StoredVideoRecord, trackedLanguages: string[], channelBaseline: string | null): string[] {
  return missingTrackedLanguages(
    { defaultLanguage: video.defaultLanguage, title: video.title, description: video.description, localizations: video.existingLocalizations },
    trackedLanguages,
    channelBaseline
  );
}

/**
 * A live broadcast that has not started (`upcoming`): a stream slot, not a video to translate -- YouTube names it itself
 * ("Прямая трансляция пользователя …") and Studio does not list it with the videos (owner, Telegram 2026-10-16, msgs 2879/2881).
 * Left out of the Languages page, its alert, its version and the export; a finished broadcast (`none`) stays.
 */
function isUpcomingBroadcast(video: StoredVideoRecord): boolean {
  return video.liveBroadcastContent === "upcoming";
}

/**
 * The channel's language first, the rest alphabetical: its column always leads the Languages table (owner, Telegram 2026-10-16,
 * msg 2883). Only reorders -- a baseline that is neither tracked nor present on any video adds no column.
 */
function baselineFirst(languages: string[], channelBaseline: string | null): string[] {
  const lead = channelBaseline ? languages.find((language) => sameLanguage(language, channelBaseline)) : undefined;
  return lead ? [lead, ...languages.filter((language) => language !== lead)] : languages;
}

/** Public, or scheduled to become public (`publishAt` set): what viewers see or are about to see. */
function isPublicOrScheduled(video: StoredVideoRecord): boolean {
  return video.privacyStatus === "public" || video.publishAt !== null;
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

/**
 * BL-178 part B (review item 2): adding or removing one language edits this computer's list; while the lists differ between the
 * computers that edit would silently drop the other computer's languages. The owner chooses a list in Merge first.
 */
async function assertTrackedLanguagesSettled(deps: ServiceDependencies, channelId: string): Promise<void> {
  const conflicted = (await deps.channelStore.getConflictedLanguageSettings?.(channelId)) ?? [];
  if (conflicted.includes("trackedLanguages")) {
    throw new DomainError({
      code: "validation_failed",
      message: "The tracked languages were set differently on your computers -- choose one list in Merge (or on the startup screen) first",
      details: { channelId },
    });
  }
}

async function requireChannelAndVideos(
  deps: ServiceDependencies,
  channelId: string
): Promise<{ channel: StoredChannelRecord; videos: StoredVideoRecord[] }> {
  const channel = await requireChannel(deps, channelId);

  const videos = (await deps.channelStore.listVideosByChannel(channelId)).filter((video) => !isUpcomingBroadcast(video));
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
        const channelBaseline = (await deps.channelLanguageBaseline?.getExpectedDefaultLanguage(channel.channelId)) ?? null;
        const realLanguages = collectChannelLanguages(videos);
        const languages = baselineFirst([...new Set([...trackedLanguages, ...realLanguages])].sort(), channelBaseline);

        const output = parseWithSchema(
          localizationOverviewOutputSchema,
          {
            channelId: channel.channelId,
            channelTitle: channel.title,
            languages,
            trackedLanguages,
            totalVideos: videos.length,
            videos: videos.map((video) => computeOverviewRow(video, languages, channelBaseline)),
          },
          "localization overview output"
        );

        return output;
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    /** BL-178 part C (§3.3 C2): the alert for this channel -- see `TranslationAlerts`. A local read. */
    async getTranslationAlerts(input: unknown): Promise<TranslationAlerts> {
      const { channelId } = parseWithSchema(channelOnlyInputSchema, input, "translation alerts input");
      try {
        const { channel, videos } = await requireChannelAndVideos(deps, channelId);
        const trackedLanguages = await deps.channelStore.getTargetLanguages(channel.channelId);
        const channelBaseline = (await deps.channelLanguageBaseline?.getExpectedDefaultLanguage(channel.channelId)) ?? null;
        const missing = videos
          .filter(isPublicOrScheduled)
          .map((video) => ({ videoId: video.videoId, title: video.title, missingLanguages: missingTrackedTranslations(video, trackedLanguages, channelBaseline) }))
          .filter((row) => row.missingLanguages.length > 0);
        const byLanguage: Record<string, number> = {};
        for (const row of missing) for (const language of row.missingLanguages) byLanguage[language] = (byLanguage[language] ?? 0) + 1;
        return { channelId: channel.channelId, trackedLanguages, videos: missing, byLanguage };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    /**
     * BL-178 part C (§3.3 C1): a fingerprint of everything the Languages page and a Change Set read for the channel -- the
     * videos' local copy (a verified Batch write or a sync changes it), the tracked languages, the channel's language and audio
     * language, and which of these differ between the computers. An open page polls it and reloads when it moves, whoever made
     * the change (this page, the Batches page, an agent, the other computer).
     */
    async getLocalizationVersion(input: unknown): Promise<LocalizationVersion> {
      const { channelId } = parseWithSchema(channelOnlyInputSchema, input, "localization version input");
      try {
        const { channel, videos } = await requireChannelAndVideos(deps, channelId);
        const trackedLanguages = await deps.channelStore.getTargetLanguages(channel.channelId);
        const channelBaseline = (await deps.channelLanguageBaseline?.getExpectedDefaultLanguage(channel.channelId)) ?? null;
        const channelBaselineAudio = (await deps.channelLanguageBaseline?.getExpectedDefaultAudioLanguage?.(channel.channelId)) ?? null;
        const conflicted = (await deps.channelStore.getConflictedLanguageSettings?.(channel.channelId).catch(() => null)) ?? null;
        const hash = createHash("sha256");
        hash.update(JSON.stringify({ trackedLanguages, channelBaseline, channelBaselineAudio, conflicted }));
        for (const video of [...videos].sort((a, b) => a.videoId.localeCompare(b.videoId))) {
          hash.update(
            JSON.stringify([video.videoId, video.title, video.description, video.defaultLanguage, video.existingLocalizations, video.privacyStatus, video.publishAt, video.lastSyncedAt.toISOString()])
          );
        }
        return { channelId: channel.channelId, version: hash.digest("hex").slice(0, 16) };
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
        await assertTrackedLanguagesSettled(deps, channel.channelId);
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
        await assertTrackedLanguagesSettled(deps, channel.channelId);
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
