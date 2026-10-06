/**
 * Automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md). Drives the existing
 * snapshot/handoff mechanism (`src/lib/device-handoff`, `src/lib/snapshot`) from a server-side
 * scheduler instead of buttons: export when local data changed, import when another device
 * published a fast-forward and this device has nothing unpublished, and otherwise ask a human.
 */

/** One published snapshot as seen in the shared folder (only what the decision needs). */
export type SnapshotEntry = {
  snapshotId: string;
  parentSnapshotId: string | null;
  sourceDeviceId: string;
  generation: number;
  schemaVersion: number;
  createdAt: string;
  /** From `lineage.json`; `null` for a snapshot from a build before automatic sync. */
  ancestors: string[] | null;
  /** From `lineage.json`: snapshots this one replaces by a human decision (backup choice only). */
  supersedes: string[];
};

export type DecisionInput = {
  deviceId: string;
  currentSchemaVersion: number;
  local: { lastSnapshotId: string | null; ancestors: string[] };
  localDirty: boolean;
  snapshots: SnapshotEntry[];
};

export type SyncDecision =
  | { kind: "idle" }
  | { kind: "export" }
  | { kind: "import"; snapshot: SnapshotEntry }
  | { kind: "divergence"; snapshot: SnapshotEntry; localDirty: boolean; multipleTips: boolean }
  | { kind: "update_app"; snapshot: SnapshotEntry };

export type DeviceSyncNoticeKind =
  | "divergence"
  | "update_app"
  | "recovery_mode"
  | "transfer_stuck"
  | "batch_in_progress"
  | "error";

export type DeviceSyncNotice = {
  kind: DeviceSyncNoticeKind;
  message: string;
  /** For divergence / update_app: the other device's snapshot this notice is about. */
  snapshotId?: string;
  sourceDeviceId?: string;
  createdAt?: string;
  localDirty?: boolean;
};

export type DeviceSyncState =
  | "disabled"
  | "not_configured"
  | "folder_unreachable"
  | "busy"
  | "synced"
  | "exported"
  | "imported"
  | "waiting"
  | "attention";

export type DeviceSyncStatus = {
  state: DeviceSyncState;
  lastTickAt: string | null;
  lastExportAt: string | null;
  lastExportSnapshotId: string | null;
  lastImportAt: string | null;
  lastImportSnapshotId: string | null;
  /** Last time another computer's branch holding exactly this computer's data was settled without asking (BL-139). */
  lastIdenticalSettledAt?: string | null;
  /** Why the last automatic background write (the dashboard's Research refresh) was skipped; null = it ran (BL-139). */
  backgroundWritesPausedReason?: string | null;
  notices: DeviceSyncNotice[];
  /** snapshotId -> first time it was seen unreadable / not yet fully transferred (ms). */
  pendingSince: Record<string, number>;
  busyReason: string | null;
  /** Snapshots this build could not import because their data needs a newer schema -- never retried
   * (each attempt would copy the whole live DB for nothing, plan §3.4). */
  unsupportedSnapshotIds: string[];
  /** The build (schema version) that recorded `unsupportedSnapshotIds`: after an app update the list
   * no longer applies and is dropped (review round 3). */
  unsupportedForSchemaVersion: number | null;
};

export const EMPTY_DEVICE_SYNC_STATUS: DeviceSyncStatus = {
  state: "synced",
  lastTickAt: null,
  lastExportAt: null,
  lastExportSnapshotId: null,
  lastImportAt: null,
  lastImportSnapshotId: null,
  lastIdenticalSettledAt: null,
  backgroundWritesPausedReason: null,
  notices: [],
  pendingSince: {},
  busyReason: null,
  unsupportedSnapshotIds: [],
  unsupportedForSchemaVersion: null,
};

/** Divergence preview (owner, Telegram 2026-10-06): transferred tables grouped the way the bell
 * names them. A table not listed falls into "Other", so a new transferred table still shows. */
export const DIVERGENCE_SECTIONS = ["Batches", "Audit", "Research", "Decisions", "Other"] as const;
export type DivergenceSection = (typeof DIVERGENCE_SECTIONS)[number];

export function divergenceSectionOf(table: string): DivergenceSection {
  if (table === "batches" || table.startsWith("batch_")) return "Batches";
  if (table === "audit_events" || table === "video_edit_audit_events") return "Audit";
  if (
    table.startsWith("research_") ||
    table.startsWith("market_") ||
    table === "channel_record_assignments" ||
    table === "topic_wikipedia_articles"
  )
    return "Research";
  if (table.startsWith("hypothes") || table.startsWith("experiment")) return "Decisions";
  return "Other";
}

export type DivergencePreview = {
  peer: { snapshotId: string; sourceDeviceId: string; createdAt: string; generation: number };
  local: { deviceId: string; headSnapshotId: string | null; lastExportAt: string | null; unpublishedChanges: boolean };
  /** How many conflicting tips there are; the comparison is with `peer` only (review round 1, #6). */
  peerTips: number;
  /** The newest snapshot both histories contain, when it is still in the sync folder. */
  commonBase: { snapshotId: string; createdAt: string; sourceDeviceId: string } | null;
  sections: Array<{ section: DivergenceSection; onlyHere: number; onlyThere: number; changed: number }>;
  /** Only the tables that differ. */
  tables: Array<{ table: string; section: DivergenceSection; onlyHere: number; onlyThere: number; changed: number }>;
};

/** §3.5 cadence. */
export const DEVICE_SYNC_TICK_MS = 30_000;
export const DEVICE_SYNC_MIN_EXPORT_INTERVAL_MS = 60_000;
/** §3.4: how long a snapshot may stay unreadable (Syncthing still transferring) before a notice. */
export const DEVICE_SYNC_TRANSFER_GRACE_MS = 10 * 60_000;
/** §3.8 retention. */
export const DEVICE_SYNC_KEEP_OWN_SNAPSHOTS = 5;
export const DEVICE_SYNC_KEEP_AUTO_IMPORT_BACKUPS = 10;
export const AUTO_IMPORT_BACKUP_PREFIX = "pre-auto-import";
export const TAKE_THEIRS_BACKUP_PREFIX = "pre-take-theirs";

export class DeviceSyncError extends Error {
  code:
    | "device_sync_not_configured"
    | "device_sync_folder_unreachable"
    | "device_sync_busy"
    | "device_sync_snapshot_not_found"
    | "device_sync_invalid_request";

  constructor(code: DeviceSyncError["code"], message: string) {
    super(message);
    this.name = "DeviceSyncError";
    this.code = code;
  }
}
