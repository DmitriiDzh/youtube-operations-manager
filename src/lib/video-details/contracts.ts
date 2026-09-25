import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  mapUnknownError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError, mapUnknownError };

/**
 * Studio-parity "Details" edit (2026-09-20, owner-authorized real-write feature). A patch is a
 * PARTIAL set of fields -- only the keys present are ever read, merged onto a freshly-fetched
 * current value, and sent. A field absent from the patch is never touched, never reset, never
 * sent as blank (AGENTS.md §F / the owner's explicit "не перезаписывая всё остальное").
 *
 * Deliberately excludes `localizations` entirely -- this module can never read or write a
 * locale; that stays the exclusive responsibility of `src/lib/localization/`/`src/lib/changesets/`
 * (no parallel implementation, AGENTS.md §D). Fields confirmed writable via the OFFICIAL
 * "You can set values for these properties" list on developers.google.com's `videos.update`/
 * `videos.insert` reference (checked live 2026-09-20) -- `defaultAudioLanguage`, `madeForKids`,
 * and every `contentDetails.*` field (age restriction, region restriction) are readable but NOT
 * settable via the public API and are excluded on purpose, not by oversight.
 */
export type VideoDetailsPatch = {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacyStatus?: "private" | "public" | "unlisted";
  /** Settable only together with `privacyStatus: "private"`, and only if the video has never
   * been published -- both enforced before any network call (schemas.ts + services.ts). */
  publishAt?: string;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  recordingDate?: string;
};

export type VideoDetailsSnapshot = {
  videoId: string;
  etag: string | null;
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  license: string | null;
  embeddable: boolean | null;
  publicStatsViewable: boolean | null;
  selfDeclaredMadeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  recordingDate: string | null;
};

export type VideoDetailsDiff = {
  field: keyof VideoDetailsPatch;
  before: unknown;
  proposed: unknown;
};

export type PreviewFieldsUpdateResult = {
  dryRun: true;
  videoId: string;
  before: VideoDetailsSnapshot;
  diff: VideoDetailsDiff[];
};

export type ApplyFieldsUpdateResult = {
  dryRun: false;
  videoId: string;
  before: VideoDetailsSnapshot;
  after: VideoDetailsSnapshot;
  verified: boolean;
  backupPath: string;
};

export type StoredChannelRecordRef = {
  channelId: string;
  connectedUserId: string | null;
};
