import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

export type ChangeField = "title" | "description";
export type ChangeType = "add" | "modify" | "unchanged";
export type ChangeValidationStatus = "valid" | "invalid";
export type ChangeConflictStatus = "none" | "conflict";
export type ChangeApprovalStatus = "pending" | "approved" | "rejected";
export type ChangeSetStatus = "in_review" | "approved" | "partially_approved" | "rejected";
export type ChangeSetSource = "xlsx_import";

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
