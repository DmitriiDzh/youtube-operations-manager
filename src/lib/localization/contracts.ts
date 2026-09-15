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
};

export type LocalizationOverview = {
  channelId: string;
  channelTitle: string;
  languages: string[];
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
