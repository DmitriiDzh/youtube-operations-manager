import {
  DomainError,
  isDomainError,
  parseWithSchema,
  mapUnknownError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, mapUnknownError };

/**
 * The operator-chosen expected language baseline for a channel (owner instruction 2026-10-02):
 * `defaultLanguage` = Studio's "Title and description language", `defaultAudioLanguage` = Studio's
 * "Video language" (`zxx` = Not applicable). `null` = no baseline chosen for that field. This is
 * pure expectation data -- nothing in this module writes to YouTube.
 */
export type ChannelLanguageDefaults = {
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
};

export type LanguageDeviationRow = {
  videoId: string;
  title: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  defaultLanguageDeviates: boolean;
  defaultAudioLanguageDeviates: boolean;
};

export type LanguageDeviationReport = {
  channelId: string;
  defaults: ChannelLanguageDefaults;
  totalVideos: number;
  /**
   * `defaultLanguage` can be aligned through the API (`videos.update` lists it as settable);
   * `defaultAudioLanguage` is NOT in the official settable list (verified 2026-10-02 against
   * developers.google.com/youtube/v3/docs/videos/update), so it is reported only -- fix in Studio.
   */
  defaultLanguageWritableViaApi: true;
  defaultAudioLanguageWritableViaApi: false;
  deviations: LanguageDeviationRow[];
};

export type StoredChannelRef = { channelId: string };
export type StoredVideoLanguageRow = {
  videoId: string;
  title: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
};
