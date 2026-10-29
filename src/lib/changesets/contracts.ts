import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  mapUnknownError,
  createIdGenerator,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError, mapUnknownError, createIdGenerator };

export type ChangeField = "title" | "description";
// "delete" (added 2026-09-21, docs/PROJECT_SPEC.md §16's 2026-09-20 deletion-policy
// update) represents a proposal to remove a language's localization entirely -- see
// src/lib/shared-localization-merge (buildSafeLocalizationsPayload) for how it is merged
// (delete-wins, applied after all other changes) and its defaultLanguage guard.
export type ChangeType = "add" | "modify" | "unchanged" | "delete";
export type ChangeValidationStatus = "valid" | "invalid";
export type ChangeConflictStatus = "none" | "conflict";
export type ChangeApprovalStatus = "pending" | "approved" | "rejected";
export type ChangeSetStatus = "in_review" | "approved" | "partially_approved" | "rejected";
export type ChangeSetSource = "xlsx_import" | "ai_localization" | "deletion";

// video-level metadata as currently mirrored by channel-sync (Phase 2). This is the
// only "remote" view Phase 4 has available -- see docs/ARCHITECTURE.md Phase 4 section
// for the documented staleness limitation (a fresh YouTube check happens in Phase 5).
export type SyncedVideoSnapshot = {
  videoId: string;
  channelId: string;
  defaultLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
};

export type Change = {
  id: string;
  changeSetId: string;
  videoId: string;
  language: string;
  field: ChangeField;
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
  conflictStatus: ChangeConflictStatus;
  approvalStatus: ChangeApprovalStatus;
  approvedValue: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeSet = {
  id: string;
  channelId: string;
  source: ChangeSetSource;
  status: ChangeSetStatus;
  importedFilename: string | null;
  schemaVersion: string | null;
  exportedAt: string | null;
  hasInvalid: boolean;
  hasConflicts: boolean;
  totalChanges: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  conflictCount: number;
  invalidCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ImportRowError = {
  row: number;
  videoId: string | null;
  language: string | null;
  message: string;
};

export type ImportSummary = {
  videosFound: number;
  localizationRows: number;
  validChanges: number;
  unchangedValues: number;
  invalidRows: number;
  conflicts: number;
};

export type ParsedFieldOutcome = {
  videoId: string;
  language: string;
  field: ChangeField;
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
  conflictStatus: ChangeConflictStatus;
};

export type ParsedRowResult = {
  row: number;
  videoId: string | null;
  language: string | null;
  rowError: string | null;
  fields: ParsedFieldOutcome[];
};

export type ParsedWorkbook = {
  schemaVersion: string | null;
  exportedAt: string | null;
  rows: ParsedRowResult[];
  errors: ImportRowError[];
  videosFound: number;
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

export type StoredChangeSetRecord = {
  id: string;
  channelId: string;
  source: string;
  status: ChangeSetStatus;
  importedFilename: string | null;
  schemaVersion: string | null;
  exportedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredChangeRecord = {
  id: string;
  changeSetId: string;
  videoId: string;
  language: string;
  field: ChangeField;
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
  conflictStatus: ChangeConflictStatus;
  approvalStatus: ChangeApprovalStatus;
  approvedValue: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  existingLocalizations: Record<string, { title: string; description: string }>;
  etag: string | null;
  lastSyncedAt: Date;
};

/** BL-232: one language's title/description of a video, as synced. */
export type LocaleText = { title: string; description: string };

/**
 * BL-232 (PRD-REQ-0043): what `proposeLanguageMove` made and what it left out. `changeSet` is null when no video needs a change.
 * - `movedVideoIds`: the video gets `toLanguage` with exactly its `fromLanguage` text, and loses `fromLanguage` (one write).
 * - `targetAlreadyPresent`: the video already has `toLanguage`; it is kept unchanged and only `fromLanguage` is removed (owner msg
 *   3784). Both texts are listed so the owner can compare them before approving.
 * - `skippedOwnLanguageVideoIds`: `fromLanguage` or `toLanguage` is the video's own language (or the channel's language baseline,
 *   which a write would give it) -- never touched.
 * - `skippedEmptyTextVideoIds`: the `fromLanguage` entry has an empty title -- nothing to move (an empty description is copied as "").
 * - `notCarryingSourceVideoIds`: only with `videoIds` -- a named video that has no `fromLanguage` entry (nothing to do for it).
 */
export type LanguageMoveResult = {
  changeSet: ChangeSet | null;
  fromLanguage: string;
  toLanguage: string;
  movedVideoIds: string[];
  targetAlreadyPresent: Array<{ videoId: string; from: LocaleText; to: LocaleText }>;
  skippedOwnLanguageVideoIds: string[];
  skippedEmptyTextVideoIds: string[];
  notCarryingSourceVideoIds: string[];
};

/**
 * BL-232 (review): a language-move set is marked in its `schemaVersion` (unused by deletion sets), so the Batch pre-write check can
 * tell which language each of its deletes moves to and refuse the write when that language holds no text any more.
 */
const LANGUAGE_MOVE_MARKER = "language-move/1";

export function languageMoveMarker(fromLanguage: string, toLanguage: string): string {
  return `${LANGUAGE_MOVE_MARKER} ${fromLanguage} ${toLanguage}`;
}

export function parseLanguageMoveMarker(schemaVersion: string | null | undefined): { fromLanguage: string; toLanguage: string } | null {
  const parts = (schemaVersion ?? "").split(" ");
  if (parts.length !== 3 || parts[0] !== LANGUAGE_MOVE_MARKER || !parts[1] || !parts[2]) return null;
  return { fromLanguage: parts[1], toLanguage: parts[2] };
}
