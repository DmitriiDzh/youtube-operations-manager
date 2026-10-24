import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  mapUnknownError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError, mapUnknownError };

/**
 * Studio-parity "Details" edit (2026-09-20, owner-authorized real-write feature). A patch is a
 * PARTIAL set of fields -- only the keys present are ever read, merged onto a freshly-fetched
 * current value, and sent. A field absent from the patch is never touched, never reset, never
 * sent as blank (AGENTS.md §F / the owner's explicit "не перезаписывая всё остальное").
 *
 * Deliberately excludes `localizations` entirely -- this module can never read or write a
 * locale; that belongs to the Change Set mechanism (`src/lib/localization/`/`src/lib/changesets/`, written by Batches) and,
 * for a live broadcast's video only, to `src/lib/live-localizations/` (BL-207, ADR 0045) -- both through the one shared merge
 * `src/lib/shared-localization-merge/` (AGENTS.md §D/§F). Fields confirmed writable via the OFFICIAL
 * "You can set values for these properties" list on developers.google.com's `videos.update`/
 * `videos.insert` reference (checked live 2026-09-20) -- `madeForKids`,
 * and every `contentDetails.*` field (age restriction, region restriction) are readable but NOT
 * settable via the public API and are excluded on purpose, not by oversight.
 */
export type VideoDetailsPatch = {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  /** Not in the official settable list; allowed experimentally (owner 2026-10-02), read-back verified. */
  defaultAudioLanguage?: string;
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
  /** `paidProductPlacementDetails.hasPaidProductPlacement` -- Studio's paid-promotion mark. Settable by `videos.update` on any
   * video, upcoming and live broadcasts included (BL-186 spike C, 2026-10-19). */
  paidProductPlacement?: boolean;
};

export type VideoDetailsSnapshot = {
  videoId: string;
  etag: string | null;
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  license: string | null;
  embeddable: boolean | null;
  publicStatsViewable: boolean | null;
  selfDeclaredMadeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  recordingDate: string | null;
  /** BL-186 stage 3: read with the other parts; optional so older snapshots stay valid. */
  paidProductPlacement?: boolean | null;
  /** Read-only (`snippet.liveBroadcastContent`: none | live | upcoming), never written. FO-REQ-0037 review: a channel agent's privacy
   * write checks it fresh, so a broadcast started after the last sync is still the owner's. */
  liveBroadcastContent?: string | null;
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
