import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// Phase 5, Slice 2 ("SAFETY PREPARATION"). Implements §19 (immutable backup) --
// docs/acceptance/PHASE_5_ACCEPTANCE.md AC-BACKUP-01..04. A separate module (not part of
// src/lib/batches/) per docs/PROJECT_SPEC.md §47's intended three-module shape
// (backup/, audit/, batches/) and docs/DEVELOPMENT_PLAYBOOK.md §6.5.

// Widened 2026-09-20 (`src/lib/video-details/`, Studio-parity real-write feature) from a single
// localization-shaped object to a discriminated union -- `captureBackup`'s caller now also
// includes a single-video field edit, a structurally different snapshot. The original shape is
// preserved unchanged as the `"localization"` variant; nothing about Batches' own usage changes
// except the `batchId` -> `operationId` param rename below (a pure rename, not a behavior
// change -- see `adapters/filesystem-store.ts`'s comment for why `operationId` is the more
// accurate name for what was always just "whatever uniquely scopes this backup's file path").
export type LocalizationBackupSnapshot = {
  kind: "localization";
  defaultLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
};

export type VideoFieldsBackupSnapshot = {
  kind: "video_fields";
  snippet: Record<string, unknown>;
  status: Record<string, unknown>;
  recordingDate: string | null;
};

export type BackupSnapshot = LocalizationBackupSnapshot | VideoFieldsBackupSnapshot;

export type BackupRecord = {
  path: string;
  capturedAt: string;
};

export type BackupHealth = { healthy: true } | { healthy: false; error: string };
