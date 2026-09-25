import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  mapUnknownError,
  type CredentialRef,
  type DomainErrorCode,
  type DomainErrorShape,
  type ResolvedCredentials,
} from "@/lib/video-metadata/contracts";

export type { CredentialRef, DomainErrorCode, DomainErrorShape, ResolvedCredentials };
export { DomainError, isDomainError, parseWithSchema, formatZodError, mapUnknownError };

export type ThumbnailInfo = {
  url: string;
  width: number | null;
  height: number | null;
};

export type LocaleMetadata = {
  title: string;
  description: string;
};

export type SyncedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: string;
  lastSyncedAt: string | null;
};

export type SyncedVideo = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, ThumbnailInfo>;
  existingLocalizations: Record<string, LocaleMetadata>;
  existingLocalizationLanguages: string[];
  lastSyncedAt: string;
  etag: string | null;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
};

export type ChannelForSync = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
};

export type VideoSyncMetadata = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, ThumbnailInfo>;
  existingLocalizations: Record<string, LocaleMetadata>;
  etag: string | null;
  // Nullable: the `statistics` part can be absent from a YouTube API response (e.g. comments
  // disabled omits commentCount) -- never defaulted to 0, which would assert a false fact.
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
  durationSeconds: number | null;
};

export type SyncChannelResult = {
  channel: SyncedChannel;
  videoCount: number;
  syncedAt: string;
};
