import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

export type LocaleMetadata = {
  title: string;
  description: string;
};

export type LocalizationVideoStatus = "complete" | "missing";

export type LocalizationOverviewRow = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  defaultLanguage: string | null;
  presentLanguages: string[];
  missingLanguages: string[];
  status: LocalizationVideoStatus;
  lastSyncedAt: string;
};

export type LocalizationOverview = {
  channelId: string;
  channelTitle: string;
  // The union of `trackedLanguages` and every language with at least one real, synced
  // localization -- this is what determines which columns the Languages tab actually renders.
  languages: string[];
  // Explicitly tracked by the operator (`proposeTrackedLanguage`/`removeTrackedLanguage`) --
  // may or may not have any real translation yet. Exposed separately from `languages` so the UI
  // can tell "this column exists only because it's tracked" from "this column has real data and
  // removing it from `trackedLanguages` alone won't hide it" (docs/roadmap/plans/
  // LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5).
  trackedLanguages: string[];
  totalVideos: number;
  videos: LocalizationOverviewRow[];
};

export type LocalizationDetailLocale = {
  language: string;
  remoteTitle: string;
  remoteDescription: string;
};

export type VideoLocalizationDetail = {
  videoId: string;
  channelId: string;
  originalTitle: string;
  originalDescription: string;
  defaultLanguage: string | null;
  locales: LocalizationDetailLocale[];
  lastSyncedAt: string;
};

export type LocalizationExportScope = "all" | "selected";

export type LocalizationExportResult = {
  filename: string;
  buffer: Buffer;
  videoCount: number;
  rowCount: number;
};

export type StoredChannelRecord = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
};

export type StoredVideoRecord = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, { url: string; width: number | null; height: number | null }>;
  existingLocalizations: Record<string, LocaleMetadata>;
  etag: string | null;
  lastSyncedAt: Date;
};
