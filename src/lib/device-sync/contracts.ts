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

export type DeviceSyncNoticeKind = "divergence" | "update_app" | "recovery_mode" | "transfer_stuck" | "error";

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
  notices: DeviceSyncNotice[];
  /** snapshotId -> first time it was seen unreadable / not yet fully transferred (ms). */
  pendingSince: Record<string, number>;
  busyReason: string | null;
};

export const EMPTY_DEVICE_SYNC_STATUS: DeviceSyncStatus = {
  state: "synced",
  lastTickAt: null,
  lastExportAt: null,
  lastExportSnapshotId: null,
  lastImportAt: null,
  lastImportSnapshotId: null,
  notices: [],
  pendingSince: {},
  busyReason: null,
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
  code: "device_sync_not_configured" | "device_sync_busy" | "device_sync_snapshot_not_found" | "device_sync_invalid_request";

  constructor(code: DeviceSyncError["code"], message: string) {
    super(message);
    this.name = "DeviceSyncError";
    this.code = code;
  }
}
