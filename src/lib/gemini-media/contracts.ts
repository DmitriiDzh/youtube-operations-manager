import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md) -- images (Nano Banana) and video (Veo 3.1) through Google's Gemini API,
// driven by the Factory Operator within the owner's limits. A separate feature module (AGENTS.md §M): it depends on the
// media gateway (its `gemini-api.ts` child), the workspace exchange and the asset catalog, never on `media-generation`
// or `generation-plans`; switched off (the default) or without a key it makes no network call.
// ---------------------------------------------------------------------------

/** The official Gemini API pricing page these prices were copied from (§1.1), "Last updated 2026-10-09 UTC". */
export const GEMINI_PRICES_AS_OF = "2026-10-09";

export type GeminiImageModelSpec = {
  label: string;
  /** Output tokens per image, by size (`image_size`): the price page's "tokens per image". */
  sizes: Readonly<Record<string, number>>;
  /** USD per 1M tokens. */
  inputPerM: number;
  textOutPerM: number;
  imageOutPerM: number;
};

export const GEMINI_IMAGE_MODELS: Readonly<Record<string, GeminiImageModelSpec>> = Object.freeze({
  "gemini-nano-banana-2.1": { label: "Nano Banana 2.1", sizes: { "1K": 1120, "2K": 1680, "4K": 3780 }, inputPerM: 1.5, textOutPerM: 7.5, imageOutPerM: 30 },
  "gemini-3.1-flash-lite-image": { label: "Nano Banana 2 Lite", sizes: { "1K": 1120 }, inputPerM: 0.25, textOutPerM: 1.5, imageOutPerM: 30 },
  "gemini-3-pro-image": { label: "Nano Banana Pro", sizes: { "1K": 1120, "2K": 1120, "4K": 2000 }, inputPerM: 2, textOutPerM: 12, imageOutPerM: 120 },
});

export type GeminiVideoModelSpec = {
  label: string;
  /** USD per second of video (with audio, the only output), by resolution; a missing resolution is not offered. */
  perSecond: Readonly<Record<string, number>>;
  referenceImages: boolean;
};

export const GEMINI_VIDEO_MODELS: Readonly<Record<string, GeminiVideoModelSpec>> = Object.freeze({
  "veo-3.1-generate-preview": { label: "Veo 3.1", perSecond: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 }, referenceImages: true },
  "veo-3.1-fast-generate-preview": { label: "Veo 3.1 Fast", perSecond: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 }, referenceImages: true },
  "veo-3.1-lite-generate-preview": { label: "Veo 3.1 Lite", perSecond: { "720p": 0.05, "1080p": 0.08 }, referenceImages: false },
});

export const GEMINI_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const GEMINI_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const GEMINI_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
export const GEMINI_VIDEO_DURATIONS = [4, 6, 8] as const;
export const GEMINI_PERSON_GENERATION = ["allow_all", "allow_adult"] as const;

export const GEMINI_LIMITS = Object.freeze({
  imagePromptChars: 10_000,
  videoPromptChars: 4_000,
  inputImages: 14,
  referenceImages: 3,
  inputBytes: 7 * 1024 * 1024,
  /** Base64 inflates by 4/3; Google's inline request limit is about 20 MB. */
  inputTotalBytes: 12 * 1024 * 1024,
  /** Tokens counted per input image in an estimate (the price pages give 560-1120; the higher one). */
  inputImageTokens: 1120,
  /** Thinking cannot be turned off for these models; the estimate allows this many text-rate tokens for it. */
  thinkingAllowanceTokens: 2000,
  maxAttempts: 3,
  /** Backoff before attempt 2 and 3 (ms). */
  retryBackoffMs: [30_000, 120_000],
  videoPollMs: 10_000,
  videoRetryMs: 30_000,
  /** Google keeps a generated video 2 days; past this the job gives up. */
  videoGiveUpMs: 47 * 3600_000,
  inFlightPerProcess: 3,
  /** A job still `submitting` this long after its claim, and not in flight here, was left by a failed write (review round 1). */
  staleSubmittingMs: 15 * 60_000,
  listMax: 50,
});

export const GEMINI_INPUT_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" });

/** The job's folder under the channel's `99 Data Exchange/From YTM/`. */
export const GEMINI_OUTPUT_SUBDIR = "gemini";
export const GEMINI_MANIFEST_FILE = "manifest.json";
export const GEMINI_KEY_FILE_NAME = "gemini-media.key";

export type GeminiMediaSettings = {
  /** The owner's switch: the operator may generate (paid). Off by default. */
  enabled: boolean;
  maxUsdPerJob: number;
  maxUsdPerDay: number;
  maxUsdPerMonth: number;
  maxActiveJobs: number;
};

export const DEFAULT_GEMINI_MEDIA_SETTINGS: GeminiMediaSettings = Object.freeze({
  enabled: false,
  maxUsdPerJob: 1,
  maxUsdPerDay: 5,
  maxUsdPerMonth: 50,
  maxActiveJobs: 10,
});

export const GEMINI_JOB_STATUSES = ["queued", "submitting", "running", "done", "failed"] as const;
export type GeminiJobStatus = (typeof GEMINI_JOB_STATUSES)[number];
export const GEMINI_ACTIVE_STATUSES: readonly GeminiJobStatus[] = ["queued", "submitting", "running"];

export type GeminiCostBasis = "usage" | "price_table" | "not_charged" | "unknown_outcome";

/** Why a job failed (stored, never thrown). */
export type GeminiJobErrorCode =
  | "gemini_blocked"
  | "gemini_invalid_request"
  | "gemini_rate_limited"
  | "gemini_unavailable"
  | "gemini_payment_required"
  | "gemini_key_invalid"
  | "gemini_key_missing"
  | "gemini_disabled"
  | "gemini_interrupted"
  | "gemini_expired"
  | "gemini_input_changed"
  | "gemini_timeout"
  | "gemini_output_failed"
  | "media_gateway_disabled";

export type GeminiInputRole = "image" | "first_frame" | "last_frame" | "reference";

export type GeminiJobInput = { role: GeminiInputRole; path: string; mimeType: string; bytes: number; sha256: string };

export type GeminiJobOutput = {
  /** Relative to the channel's `99 Data Exchange/From YTM/`, `/` separators: `gemini/<jobId>/image-1.png`. */
  path: string;
  localPath: string;
  kind: "image" | "video";
  mimeType: string;
  bytes: number;
  sha256: string;
  assetId: string | null;
  note: string | null;
};

export type GeminiImageParams = { size: string; aspectRatio: string };
export type GeminiVideoParams = { resolution: string; aspectRatio: string; durationSeconds: number; personGeneration?: string };

export type GeminiJobView = {
  jobId: string;
  channelId: string;
  requestId: string | null;
  kind: "image" | "video";
  model: string;
  prompt: string;
  params: GeminiImageParams | GeminiVideoParams;
  inputs: GeminiJobInput[];
  status: GeminiJobStatus;
  estimateUsd: number;
  costUsd: number | null;
  costBasis: GeminiCostBasis | null;
  outputs: GeminiJobOutput[];
  error: string | null;
  errorCode: string | null;
  attempts: number;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
};

export type GeminiSpend = { todayUsd: number; monthUsd: number; activeUsd: number; activeJobs: number };

export type GeminiKeyView = { configured: boolean; keyHint: string | null; status: "ok" | "payment_required" | null; verifiedAt: string | null; updatedAt: string | null };

export type GeminiLimitName = "per_job" | "per_day" | "per_month" | "active_jobs";

export type GeminiRefusal = { code: "gemini_limit_exceeded" | "gemini_disabled" | "gemini_key_missing"; message: string; details?: Record<string, unknown> };

/** The manifest written last into the job's folder (§2.4); every field copied explicitly, no key, no billing data. */
export type GeminiJobManifest = {
  schema: "ytm.gemini-job-manifest";
  schemaVersion: 1;
  jobId: string;
  channelId: string;
  kind: "image" | "video";
  model: string;
  prompt: string;
  params: GeminiImageParams | GeminiVideoParams;
  inputs: Array<{ role: GeminiInputRole; path: string; bytes: number; sha256: string }>;
  status: "done";
  estimateUsd: number;
  costUsd: number;
  costBasis: GeminiCostBasis;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string;
  device: { deviceId: string | null; hostname: string | null };
  outputs: Array<{ path: string; kind: "image" | "video"; mimeType: string; bytes: number; sha256: string; assetId: string | null; note: string | null }>;
};

/** A table entry by its OWN key only: "toString", "constructor" or "__proto__" are never a model, size or extension (review round 1). */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function geminiJobNotFound(jobId: string): DomainError {
  return new DomainError({ code: "gemini_job_not_found", message: `No Gemini job ${jobId} on this computer.`, details: { jobId } });
}

export function geminiInvalidParams(field: string, message: string): DomainError {
  return new DomainError({ code: "gemini_invalid_params", message, details: { field } });
}
