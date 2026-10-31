/**
 * BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): the disk guard. Every 15 minutes the server checks the free space of
 * the volumes it writes to (the app-data folder's and the program folder's). When it falls below the threshold (20 GB by
 * default, a setting of this computer) it raises ONE bell notice and posts ONE message to the HUB "System" topic (when that
 * topic is on here) with the free space and the app's biggest folders. It alerts again only after the space recovered above
 * the threshold + 2 GB and fell again, or after 24 h still below. A feature module (AGENTS.md §M): nothing else depends on it,
 * and it depends on no other feature module (the System topic is handed in by `src/composition/disk-guard.ts`).
 */

/** How often the server checks the disk. */
export const DISK_GUARD_TICK_MS = 15 * 60_000;
/** The first check after the server starts. */
export const DISK_GUARD_FIRST_CHECK_MS = 3 * 60_000;
/** Bytes in one GB as the disk is sold and as Finder / Explorer's "GB" reads: 10^9. */
export const GB = 1_000_000_000;
export const DEFAULT_DISK_GUARD_THRESHOLD_GB = 20;
export const DISK_GUARD_THRESHOLD_MIN_GB = 1;
export const DISK_GUARD_THRESHOLD_MAX_GB = 10_000;
/** An alert ends only when the free space is back above the threshold by this much (no alert storm around the line). */
export const DISK_GUARD_RECOVERY_MARGIN_GB = 2;
/** Still below the threshold this long after the last alert: one more alert. */
export const DISK_GUARD_REALERT_MS = 24 * 60 * 60 * 1000;
/** How long measuring one folder may take before it stops and says "at least" (the walk is cheap but $TMPDIR can be huge). */
export const DISK_GUARD_WALK_BUDGET_MS = 8_000;

export type DiskGuardSettings = { thresholdGb: number };

/** A volume the app writes to; `labels` name which of the app's places live on it. */
export type DiskVolume = { labels: Array<"appData" | "program">; path: string; freeBytes: number; totalBytes: number };

export type DiskConsumerKey = "liveStreamsBuffer" | "backups" | "nextCache" | "tempDir";
/** One of the app's big folders: its size, or `complete: false` when measuring stopped at the time budget (a lower bound). */
export type DiskConsumer = { key: DiskConsumerKey; path: string; bytes: number; complete: boolean };

/** What the guard remembers between checks (this computer's `app_settings`, never in a snapshot). */
export type DiskGuardState = {
  alertActive: boolean;
  /** When the current alert was last raised (ms), null when none was. */
  lastAlertAt: number | null;
  lastCheckAt: number | null;
  /** The lowest free space of the volumes at the last check. */
  lastFreeBytes: number | null;
  /** Why the last check could not read the disk, or null. */
  lastError: string | null;
};

export const INITIAL_DISK_GUARD_STATE: DiskGuardState = { alertActive: false, lastAlertAt: null, lastCheckAt: null, lastFreeBytes: null, lastError: null };

/** The bell's notice: present while an alert is active. */
export type DiskGuardNotice = { freeBytes: number; thresholdGb: number; since: string };

export type DiskGuardView = {
  settings: DiskGuardSettings;
  volumes: DiskVolume[];
  /** Null when the disk could not be read now. */
  volumesError: string | null;
  notice: DiskGuardNotice | null;
  lastCheckAt: string | null;
  /** Only when asked to measure (the card's refresh button). */
  consumers: DiskConsumer[] | null;
};

export type DiskGuardDeps = {
  /** The volumes of the app's places (statfs), one entry per volume. Throws when the disk cannot be read. */
  volumes(): Promise<DiskVolume[]>;
  /** The sizes of the app's big folders, each bounded in time. */
  measureConsumers(): Promise<DiskConsumer[]>;
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  getStateJson(): Promise<string | null>;
  setStateJson(json: string): Promise<void>;
  /** Posts to the HUB "System" topic; false when the topic is not on here (nothing queued). */
  postSystemMessage(text: string): Promise<boolean>;
  hostname(): string;
  clock(): number;
  log?(event: string, context: Record<string, unknown>): void;
};
