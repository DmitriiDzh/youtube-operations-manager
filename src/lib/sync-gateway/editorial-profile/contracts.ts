import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

/**
 * One channel's editorial profile as an Automerge document (2026-09-22,
 * `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Category B / §4). Unlike
 * `change-drafts/`'s `ChannelDraftDocument` (a map of many entities per channel), this is a
 * single flat object per channel -- `channel_editorial_profiles.channel_id` is the table's own
 * PRIMARY KEY, genuinely one row per channel. Every field maps 1:1 onto `src/lib/db.ts`'s
 * `channel_editorial_profiles` columns.
 */
export type EditorialProfileDocument = {
  channelId: string;
  /** 0 means "never actually saved" -- the sentinel a fresh, never-persisted document starts at
   * (mirrors the old direct-SQL `upsertStoredEditorialProfile`'s own "starts at 1" convention,
   * shifted by one so `loadOrCreate`'s synthetic empty document is distinguishable from a real
   * save without a separate boolean). */
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

/** The subset of fields that can genuinely conflict between two devices editing the same profile
 * concurrently -- `channelId`/`version`/`updatedAt` are bookkeeping this module itself controls,
 * never independently authored by two devices in a way worth surfacing as a conflict (mirrors
 * `change-drafts/services.ts`'s own `MUTABLE_CHANGE_FIELDS` exclusion of `updatedAt`). */
export const EDITORIAL_PROFILE_CONFLICT_FIELDS = [
  "targetAudience",
  "toneNotes",
  "terminologyNotes",
  "titleConstraints",
  "descriptionConstraints",
] as const satisfies readonly (keyof EditorialProfileDocument)[];

export type FieldConflict = {
  field: (typeof EDITORIAL_PROFILE_CONFLICT_FIELDS)[number];
  valuesByActor: Record<string, unknown>;
};

export type MergeResult = { newConflicts: FieldConflict[] };
