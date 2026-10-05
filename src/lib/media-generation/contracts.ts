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
  | { configured: false; reason: "no_credentials" | "key_file_missing" | "key_file_invalid" }
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

/** The ONE list of session statuses and its terminal subset (review round 21): `db.ts` imports these for the column enum and for freeing the open slot. */
export const MEDIA_SESSION_STATUSES = ["pending", "approved", "starting", "running", "stopping", "done", "failed", "rejected", "interrupted"] as const;
export type MediaSessionStatus = (typeof MEDIA_SESSION_STATUSES)[number];
export const MEDIA_SESSION_TERMINAL_STATUSES: readonly MediaSessionStatus[] = ["done", "failed", "rejected", "interrupted"];
export const MEDIA_SESSION_NON_TERMINAL_STATUSES: readonly MediaSessionStatus[] = MEDIA_SESSION_STATUSES.filter((s) => !MEDIA_SESSION_TERMINAL_STATUSES.includes(s));

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

// -- workflow templates and jobs (slice 3, PHASE_14_PLAN.md §2.4, owner decision D7) ------------------

export type MediaParameterType = "string" | "text" | "number" | "integer" | "boolean" | "enum";

/** One value an agent may set on an imported graph: which node input it writes, with its bounds. */
export type MediaTemplateParameter = {
  name: string;
  type: MediaParameterType;
  nodeId: string;
  input: string;
  required: boolean;
  default: string | number | boolean | null;
  min: number | null;
  max: number | null;
  enum: string[] | null;
  description: string | null;
};

export type MediaWorkflowTemplate = {
  templateId: string;
  name: string;
  version: number;
  description: string | null;
  parameters: MediaTemplateParameter[];
  /** Node ids whose `filename_prefix` is rewritten to `<jobId>/...` so outputs land in the job's folder. */
  outputNodeIds: string[];
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MediaJobStatus = "queued" | "submitted" | "generating" | "transferring" | "done" | "failed" | "cancelled";
export const MEDIA_JOB_TERMINAL_STATUSES: readonly MediaJobStatus[] = ["done", "failed", "cancelled"];

export type MediaJobOutput = {
  nodeId: string;
  /** ComfyUI's output kind (`images`, `audio`, `gifs`, ...). */
  kind: string;
  filename: string;
  subfolder: string;
  remoteKey: string;
  /** Absolute path under `<workspace>/99 Data Exchange/From YTM/media/<jobId>/`, once pulled. */
  localPath: string | null;
  bytes: number | null;
  sha256: string | null;
  remoteDeleted: boolean;
  assetId: string | null;
  /** Set when the file could not be pulled or was outside the job's folder. */
  note: string | null;
};

export type MediaJob = {
  jobId: string;
  sessionId: string;
  channelId: string;
  templateId: string;
  templateVersion: number;
  params: Record<string, string | number | boolean>;
  status: MediaJobStatus;
  createdBy: "operator" | "agent";
  promptId: string | null;
  outputs: MediaJobOutput[];
  assetIds: string[];
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
};

/** Where this job's outputs are written locally, relative to the From YTM folder. */
export const MEDIA_OUTPUT_SUBDIR = "media";
/** The volume prefix ComfyUI writes to (`--output-directory /workspace/exchange`) and the only prefix the janitor touches. */
export const EXCHANGE_PREFIX = "exchange/";
/** Reference inputs for ComfyUI (`--input-directory /workspace/exchange/in`); never cleaned by the janitor. */
export const EXCHANGE_INPUT_PREFIX = "exchange/in/";

export type MediaCredentialsTestResult = {
  runpod: { ok: true } | { ok: false; message: string };
  s3: { ok: true } | { ok: false; message: string } | { skipped: true; reason: string };
  verifiedAt: string | null;
};
