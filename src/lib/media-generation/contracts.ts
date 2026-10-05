import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

// ---------------------------------------------------------------------------
// Phase 14 -- remote media generation (docs/roadmap/plans/PHASE_14_PLAN.md). Slice 1 owns the
// credentials (entered in Settings, encrypted with a per-device key file, §2.9), the settings
// blob (§2.6), and typed access to the RunPod catalog/volumes/pods through `media-gateway`.
// Sessions and jobs are later slices. Nothing here ever returns a secret to a caller.
// ---------------------------------------------------------------------------

export const MEDIA_KEY_FILE_NAME = "media-generation.key";
/** The pod port the token proxy listens on (scripts/media/pod/Caddyfile); ComfyUI itself stays on 127.0.0.1:8188. */
export const COMFY_PROXY_PORT = 8189;
/** Characters of the RunPod key kept in plaintext for recognition in the UI ("rpa_ab12…"). */
export const RUNPOD_KEY_PREFIX_LENGTH = 8;

export type MediaCredentialsStatus =
  | { configured: false; reason: "no_credentials" | "key_file_missing" }
  | {
      configured: true;
      runpodKeyPrefix: string;
      s3AccessKeyId: string | null;
      verifiedAt: string | null;
      updatedAt: string;
    };

export type MediaCloudType = "SECURE" | "COMMUNITY";

export type MediaSettings = {
  datacenterId: string | null;
  gpuTypeId: string | null;
  cloudType: MediaCloudType;
  networkVolumeId: string | null;
  templateId: string | null;
  /** Daily spend cap in USD across all sessions (AC-P14-03/17). */
  maxUsdPerDay: number;
  /** Default `maxMinutes` for a new session request. */
  defaultMaxMinutes: number;
  /** A running session with no non-terminal job for this long is terminated (AC-P14-06). */
  idleMinutes: number;
  /** How often the watcher checks a running session (owner decision D2: operator-set). */
  watchIntervalSeconds: number;
  /** The chosen GPU's on-demand $/h as the catalog reported it when the GPU was saved -- the
   * local price a session estimate uses with zero RunPod calls (AC-P14-03). */
  gpuOnDemandPricePerHr: number | null;
};

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = Object.freeze({
  datacenterId: null,
  gpuTypeId: null,
  cloudType: "SECURE",
  networkVolumeId: null,
  templateId: null,
  maxUsdPerDay: 10,
  defaultMaxMinutes: 60,
  idleMinutes: 10,
  watchIntervalSeconds: 60,
  gpuOnDemandPricePerHr: null,
});

/** Network-volume price used for the Settings estimate only (docs.runpod.io/storage/network-volumes, 2026-10-05). */
export const NETWORK_VOLUME_USD_PER_GB_MONTH = 0.07;

export type MediaGenerationOverview = {
  credentials: MediaCredentialsStatus;
  settings: MediaSettings;
  gatewayEnabled: boolean;
  /** True when a session could be started: credentials + datacenter + GPU + volume + template. */
  ready: boolean;
  /** Human-readable names of what is still missing when `ready` is false. */
  missing: string[];
};

// -- sessions (slice 2, PHASE_14_PLAN.md §2.3) ---------------------------------------------------

export type MediaSessionStatus = "pending" | "approved" | "starting" | "running" | "stopping" | "done" | "failed" | "rejected" | "interrupted";
export const MEDIA_SESSION_TERMINAL_STATUSES: readonly MediaSessionStatus[] = ["done", "failed", "rejected", "interrupted"];
export const MEDIA_SESSION_NON_TERMINAL_STATUSES: readonly MediaSessionStatus[] = ["pending", "approved", "starting", "running", "stopping"];

/** Public shape -- never the proxy token. */
export type MediaSession = {
  sessionId: string;
  channelId: string;
  status: MediaSessionStatus;
  requestedBy: "operator" | "agent";
  reason: string | null;
  maxMinutes: number;
  maxUsd: number | null;
  /** Upper bound at request time: `costPerHr × maxMinutes / 60` (AC-P14-03). */
  estimateUsd: number;
  fitsToday: boolean;
  costPerHr: number | null;
  gpuTypeId: string | null;
  datacenterId: string | null;
  podId: string | null;
  comfyUiProxyUrl: string | null;
  createdAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  lastActivityAt: string | null;
  stoppedAt: string | null;
  /** Pod creation -> confirmed termination (AC-P14-17); for a running session, the live value. */
  secondsUsed: number | null;
  usdCharged: number | null;
  stopReason: string | null;
  error: string | null;
};

export type MediaSessionLimits = {
  maxUsdPerDay: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  defaultMaxMinutes: number;
  idleMinutes: number;
  watchIntervalSeconds: number;
  /** The device's single non-terminal session, if any. */
  openSession: MediaSession | null;
  ready: boolean;
  missing: string[];
};

export type MediaCredentialsTestResult = {
  runpod: { ok: true } | { ok: false; message: string };
  s3: { ok: true } | { ok: false; message: string } | { skipped: true; reason: string };
  verifiedAt: string | null;
};
