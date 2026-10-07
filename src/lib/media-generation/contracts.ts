import type { JobLiveProgress } from "./job-progress";
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
  /**
   * Slice 6 (owner, Telegram 2026-10-05, msgs 1549/1551/1553): how many sessions may hold a pod at once
   * (`approved|starting|running|stopping`), each its own pod on the shared volume. Pending requests are not bounded.
   */
  maxConcurrentSessions: number;
  /** The chosen GPU's on-demand $/h as the catalog reported it when the GPU was saved -- the
   * local price a session estimate uses with zero RunPod calls (AC-P14-03). */
  gpuOnDemandPricePerHr: number | null;
  // -- BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md) ---------------------------------------------------------
  /** Further GPU types tried in order when the chosen one cannot be placed (also for the owner's own sessions, O5). */
  gpuFallbackIds: string[];
  /** A candidate with less VRAM is never tried (null = no minimum). */
  gpuMinVramGb: number | null;
  /** A candidate dearer than this is never tried (null = no cap). */
  gpuMaxPricePerHr: number | null;
  /** While no candidate can be placed, the start is retried this often (owner: 30 s) ... */
  capacityRetrySeconds: number;
  /** ... for at most this long, then the session fails with `media_no_capacity`. */
  capacityWaitMinutes: number;
  /** Master switch for sessions the Factory Operator starts itself (on by default, owner 2026-10-06 msg 1683). */
  factorySessionsEnabled: boolean;
  /** A factory start is approved by itself only within ALL of these (owner defaults, O2); above them it waits for the owner. */
  factoryMaxUsdPerSession: number;
  factoryMaxMinutesPerSession: number;
  factoryMaxUsdPerDay: number;
  factoryMaxUsdPerMonth: number;
  /** Owner, Telegram 2026-10-06 (msgs 1807/1810): the owner's OWN session requests (Production → Sessions) are stopped by
   * themselves one minute after their last job finished (BL-135 releaseWhenDone). Never applied to agent/factory requests. */
  ownerReleaseWhenDone: boolean;
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
  maxConcurrentSessions: 3,
  gpuOnDemandPricePerHr: null,
  gpuFallbackIds: [],
  gpuMinVramGb: null,
  gpuMaxPricePerHr: null,
  capacityRetrySeconds: 30,
  capacityWaitMinutes: 30,
  factorySessionsEnabled: true,
  factoryMaxUsdPerSession: 2,
  factoryMaxMinutesPerSession: 60,
  factoryMaxUsdPerDay: 5,
  factoryMaxUsdPerMonth: 50,
  ownerReleaseWhenDone: true,
});

/** Bounds of `maxConcurrentSessions` (slice 6): at least one, at most four pods at a time. */
export const MAX_CONCURRENT_SESSIONS_RANGE = Object.freeze({ min: 1, max: 4 });

/** A session holding (or about to hold) a pod: the statuses `maxConcurrentSessions` counts. */
export const MEDIA_SESSION_ACTIVE_STATUSES = ["approved", "waiting_capacity", "starting", "running", "stopping"] as const;

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
/**
 * BL-133: `waiting_capacity` = approved, but no GPU candidate could be placed; no pod exists (nothing is billed), the start is
 * retried every `capacityRetrySeconds` until `capacityWaitMinutes`, and the session keeps its concurrency slot meanwhile.
 */
export const MEDIA_SESSION_STATUSES = ["pending", "approved", "waiting_capacity", "starting", "running", "stopping", "done", "failed", "rejected", "interrupted"] as const;
export type MediaSessionStatus = (typeof MEDIA_SESSION_STATUSES)[number];
export type MediaSessionRequester = "operator" | "agent" | "factory";
/** BL-133: an ordered list of GPU types to try, optionally bounded by VRAM and price (a request's or a template's). */
export type MediaGpuPlan = { candidates: string[]; minVramGb: number | null; maxPricePerHr: number | null };
/** BL-133: one createPod attempt as the capacity log records it. */
export type MediaCapacityAttempt = { at: string; sessionId: string; datacenterId: string | null; gpuTypeId: string; pricePerHr: number | null; result: "placed" | "no_capacity" | "error"; detail: string | null };
export const MEDIA_SESSION_TERMINAL_STATUSES: readonly MediaSessionStatus[] = ["done", "failed", "rejected", "interrupted"];
export const MEDIA_SESSION_NON_TERMINAL_STATUSES: readonly MediaSessionStatus[] = MEDIA_SESSION_STATUSES.filter((s) => !MEDIA_SESSION_TERMINAL_STATUSES.includes(s));

/** Public shape -- never the proxy token. */
export type MediaSession = {
  sessionId: string;
  channelId: string;
  status: MediaSessionStatus;
  /** BL-133: `factory` = started by the Factory Operator through its own endpoint. */
  requestedBy: MediaSessionRequester;
  /** BL-133: who approved it -- `owner` (Web) or `factory` (within the owner's factory limits); null while pending. */
  approvedBy: "owner" | "factory" | null;
  /** BL-133: the GPU candidates this session was asked to try (null = the device's GPU + its fallback list). */
  gpuPlan: MediaGpuPlan | null;
  /** BL-133: while `waiting_capacity` -- when the next start attempt is due and when the wait ends. */
  capacity: { attempts: number; nextAttemptAt: string | null; waitUntil: string | null } | null;
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
  /** BL-135: stop the pod by itself once every job of the session is finished and none followed for a minute. */
  releaseWhenDone: boolean;
};

/**
 * FO-REQ-0005 item 4: the owner's factory settings as the Factory Operator may read them (`factory_media_get_settings`).
 * Limits, spend and GPU choices only -- no key, token or credential is part of `MediaSettings` or of this view.
 */
export type MediaFactorySettingsView = {
  factorySessionsEnabled: boolean;
  limits: { maxUsdPerSession: number; maxMinutesPerSession: number; maxUsdPerDay: number; maxUsdPerMonth: number };
  /** What the factory's sessions spent, plus what its open ones may still spend up to their caps -- the numbers a start is checked against. */
  spentOrReservedUsd: { today: number; thisMonth: number };
  /** The device-wide limits every session (owner's and factory's) is also held to. */
  device: { maxUsdPerDay: number; spentTodayUsd: number; maxConcurrentSessions: number; idleMinutes: number };
  gpu: { gpuTypeId: string | null; fallbackIds: string[]; minVramGb: number | null; maxPricePerHr: number | null; onDemandPricePerHr: number | null; cloudType: MediaCloudType };
  capacity: { retrySeconds: number; waitMinutes: number };
};

export type MediaSessionLimits = {
  maxUsdPerDay: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  defaultMaxMinutes: number;
  idleMinutes: number;
  watchIntervalSeconds: number;
  /** Every non-terminal session on this device (pending included), oldest first (slice 6). */
  openSessions: MediaSession[];
  /** The first of `openSessions` -- kept for Agent API < 3.4 callers. */
  openSession: MediaSession | null;
  maxConcurrentSessions: number;
  /** Sessions currently holding a pod (`approved|starting|running|stopping`). */
  activeSessionCount: number;
  ready: boolean;
  missing: string[];
};

// -- workflow templates and jobs (slice 3, PHASE_14_PLAN.md §2.4, owner decision D7) ------------------

export type MediaParameterType = "string" | "text" | "number" | "integer" | "boolean" | "enum" | MediaInputParameterType;

/**
 * BL-132 (plan §2.4): a job INPUT file -- the job value is a path relative to the channel workspace's
 * `99 Data Exchange/Sent to YTM/`; the file is uploaded for that job and the targeted loader input gets its name.
 */
export type MediaInputParameterType = "image" | "audio" | "video";
export const MEDIA_INPUT_PARAMETER_TYPES: readonly MediaInputParameterType[] = ["image", "audio", "video"];
/** Owner answer O5: 500 MB per input (the S3 single-PUT limit too). */
export const MEDIA_INPUT_MAX_BYTES = 500 * 1024 * 1024;
/** Extensions accepted when a parameter declares no `accept` list. */
export const MEDIA_INPUT_DEFAULT_ACCEPT: Readonly<Record<MediaInputParameterType, readonly string[]>> = {
  image: [".png", ".jpg", ".jpeg", ".webp"],
  audio: [".wav", ".mp3", ".flac", ".ogg", ".m4a"],
  video: [".mp4", ".webm", ".mov", ".mkv"],
};

export function isInputParameterType(type: string): type is MediaInputParameterType {
  return (MEDIA_INPUT_PARAMETER_TYPES as readonly string[]).includes(type);
}

/** One input file of a job as uploaded to the volume (`exchange/in/<jobId>-<parameter>-<name>`). */
export type MediaJobInput = { parameter: string; sourcePath: string; remoteKey: string; bytes: number; sha256: string; uploadedAt: string; remoteDeleted: boolean };

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
  /** BL-132 input types only: accepted extensions (lower-case, with the dot); absent = the type's default list. */
  accept?: string[] | null;
  /** BL-132 input types only: size limit in bytes (≤ 500 MB); absent = 500 MB. */
  maxBytes?: number | null;
};

/** The model folders on the network volume (`models/<folder>/`), the ComfyUI `extra_model_paths.yaml` names. */
export const MEDIA_MODEL_FOLDERS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "clip_vision", "audio_encoders", "upscale_models", "controlnet", "embeddings"] as const;
export type MediaModelFolder = (typeof MEDIA_MODEL_FOLDERS)[number];

/** A model a template loads (BL-132): declared in a registry template's `models`, derived from a local template's graph. */
export type MediaModelReference = { folder: MediaModelFolder | null; file: string; sha256: string | null };

export type MediaWorkflowTemplate = {
  templateId: string;
  name: string;
  version: number;
  description: string | null;
  /** BL-132: `owner` = imported by hand on this device (local), `factory` = installed from the factory template registry. */
  source: "owner" | "factory";
  /** BL-132: a factory template's declared models; for a local template, the literal model names its loader nodes use. */
  models: MediaModelReference[];
  /** BL-133: the GPUs a registry template asks for (null = none declared). */
  gpu: MediaGpuPlan | null;
  parameters: MediaTemplateParameter[];
  /** Node ids whose `filename_prefix` is rewritten to `<jobId>/...` so outputs land in the job's folder. */
  outputNodeIds: string[];
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
};

/** BL-132 (plan §2.5): one audit row as shown in the Web UI and the factory tools. */
export type MediaControlEventView = { at: string; actor: "owner" | "factory" | "sync"; action: string; subject: string; details: Record<string, unknown> | null };

/** BL-132 (plan §2.2): the network volume as RunPod reports it. RunPod bills the rented size. */
/**
 * BL-136 (owner, Telegram 2026-10-06, msg 1709): what occupies the volume, summed from one S3 listing of the whole volume --
 * RunPod's volume API does not report used space. `modelsBytes` counts every object under `models/` (including the
 * Hugging Face cache and folder markers: they take space too), `exchangeBytes` everything under `exchange/`.
 */
export type MediaVolumeUsage = { totalBytes: number; modelsBytes: number; exchangeBytes: number; otherBytes: number; objectCount: number };
export type MediaStorageStatus = { volumeId: string; dataCenterId: string | null; sizeGb: number; usedGb: number | null; freeGb: number | null; monthlyUsd: number };

/**
 * BL-132 (plan §2.2, owner addition A1): which templates use which model file. `registry` = whether the factory template
 * registry could be read on this device; when it could not, a factory deletion is refused (fail closed).
 */
export type MediaModelUsage = {
  registry: "ok" | "unavailable";
  registryError: string | null;
  users: Array<{ key: string; templateId: string; version: number; source: "factory" | "owner" | "registry" }>;
};

/** A model file on the volume with its verified hash (when a pull recorded one) and the templates that use it. */
export type MediaModelEntry = {
  key: string;
  folder: string;
  name: string;
  bytes: number;
  lastModified: string | null;
  sha256: string | null;
  usedBy: Array<{ templateId: string; version: number; source: "factory" | "owner" | "registry" }>;
};

/** BL-132: what started a template-registry sync (`auto` = the 60 s check found a change). */
export type MediaTemplateSyncTrigger = "auto" | "factory" | "owner";

/** BL-132 (plan §2.3): what a sync did -- or, for a dry run, would do. `unavailable` = the registry could not be read: nothing changed. */
export type MediaTemplateSyncResult = {
  at: string;
  trigger: MediaTemplateSyncTrigger;
  dryRun: boolean;
  outcome: "ok" | "unavailable";
  error: string | null;
  installed: Array<{ templateId: string; version: number }>;
  updated: Array<{ templateId: string; from: number; to: number }>;
  removed: Array<{ templateId: string; version: number }>;
  unchanged: Array<{ templateId: string; version: number }>;
  /** Listed in the index, file not there yet (a file sync still copying): the installed version, if any, stays. */
  pending: Array<{ templateId: string; version: number }>;
  /** Refused with the reason; the installed version, if any, stays. */
  invalid: Array<{ templateId: string; version: number; reason: string }>;
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
  createdBy: "operator" | "agent" | "factory";
  promptId: string | null;
  outputs: MediaJobOutput[];
  assetIds: string[];
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  /** BL-132: the job's input files as uploaded to the volume (empty when the template has no input parameter). */
  inputs?: MediaJobInput[];
  /**
   * BL-144: live progress from ComfyUI's own execution events, present only while this device watches the job's
   * generation (job-progress.ts). Never estimated.
   */
  progress?: JobLiveProgress;
};

/** Where this job's outputs are written locally, relative to the From YTM folder. */
export const MEDIA_OUTPUT_SUBDIR = "media";
/**
 * FO-REQ-0002: the file written LAST into `media/<jobId>/` once the job is final (`done`, or `failed` with a folder).
 * Reserved: an output with this name at the job's top level is never pulled over it.
 */
export const MEDIA_JOB_MANIFEST_FILE = "manifest.json";

/** `manifest.json` content (FO-REQ-0002). An explicit allowlist: no credentials, account identities, pod or billing data. */
export type MediaJobManifest = {
  schema: "ytm.media-job-manifest";
  schemaVersion: 1;
  jobId: string;
  sessionId: string;
  channelId: string;
  status: "done" | "failed";
  error: string | null;
  template: { templateId: string; templateVersion: number; name: string | null };
  params: Record<string, string | number | boolean>;
  createdBy: "operator" | "agent" | "factory";
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string;
  device: { deviceId: string | null; hostname: string | null };
  /** Delivered files; `path` is relative to `media/<jobId>/`, always with `/` separators. */
  outputs: Array<{ path: string; kind: "image" | "audio" | "video" | "other"; comfyKind: string; nodeId: string; bytes: number; sha256: string; assetId: string | null; note: string | null }>;
  /** Outputs ComfyUI produced that are NOT in the folder, with the reason. */
  missing: Array<{ nodeId: string; comfyKind: string; filename: string; subfolder: string; note: string | null }>;
};
/** The volume prefix ComfyUI writes to (`--output-directory /workspace/exchange`) and the only prefix the janitor touches. */
export const EXCHANGE_PREFIX = "exchange/";
/** Reference inputs for ComfyUI (`--input-directory /workspace/exchange/in`); never cleaned by the janitor. */
export const EXCHANGE_INPUT_PREFIX = "exchange/in/";

export type MediaCredentialsTestResult = {
  runpod: { ok: true } | { ok: false; message: string };
  s3: { ok: true } | { ok: false; message: string } | { skipped: true; reason: string };
  verifiedAt: string | null;
};
