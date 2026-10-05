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

export type MediaCredentialsTestResult = {
  runpod: { ok: true } | { ok: false; message: string };
  s3: { ok: true } | { ok: false; message: string } | { skipped: true; reason: string };
  verifiedAt: string | null;
};
