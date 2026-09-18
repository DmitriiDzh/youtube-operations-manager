import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// Phase 5, Slice 2 ("SAFETY PREPARATION"). Implements §19 (immutable backup) --
// docs/acceptance/PHASE_5_ACCEPTANCE.md AC-BACKUP-01..04. A separate module (not part of
// src/lib/batches/) per docs/PROJECT_SPEC.md §47's intended three-module shape
// (backup/, audit/, batches/) and docs/DEVELOPMENT_PLAYBOOK.md §6.5.

export type BackupSnapshot = {
  defaultLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
};

export type BackupRecord = {
  path: string;
  capturedAt: string;
};

export type BackupHealth = { healthy: true } | { healthy: false; error: string };
