import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057, docs/roadmap/plans/SUMIRE_VOICE_PLAN.md stage S4): speech through ElevenLabs -- one take of text
// in an APPROVED designed voice of the channel, run by the Factory Operator (or a channel's worker) within the owner's limits. A
// feature module shaped like `gemini-media` (AGENTS.md §M): it reaches ElevenLabs only through the media gateway's
// `elevenlabs-api.ts`, knows voices only through an injected resolver, and imports no other feature module. Switched off (the
// default) or without a key it makes no network call.
//
// Owner decisions (Telegram 2026-10-29 msgs 3814-3817): the cheapest subscription -- limits are counted in CHARACTERS (per job,
// per day, per month) plus the active jobs, not in dollars; the dollar figure is a list-price estimate for the spend views only.
// The output format is whatever the plan allows (default mp3_44100_128, settable).
// ---------------------------------------------------------------------------

/** UNVERIFIED: model ids and list prices from R-0005 (read 2026-10-29); `eleven_v4` is the id R-0005 implies for Eleven v4. */
export const ELEVENLABS_PRICES_AS_OF = "2026-10-29";

export type ElevenlabsModelSpec = { label: string; usdPer1kChars: number; maxChars: number };

export const ELEVENLABS_SPEECH_MODELS: Readonly<Record<string, ElevenlabsModelSpec>> = Object.freeze({
  eleven_v4: { label: "Eleven v4", usdPer1kChars: 0.08, maxChars: 10_000 },
  eleven_v3: { label: "Eleven v3", usdPer1kChars: 0.08, maxChars: 5_000 },
  eleven_multilingual_v2: { label: "Eleven Multilingual v2", usdPer1kChars: 0.08, maxChars: 10_000 },
  eleven_flash_v2_5: { label: "Eleven Flash v2.5", usdPer1kChars: 0.04, maxChars: 10_000 },
});

export const ELEVENLABS_DEFAULT_MODEL = "eleven_v4";
/** Voice Design v3 (the only design model used here). */
export const ELEVENLABS_DESIGN_MODEL = "eleven_ttv_v3";

/** The output formats offered (ElevenLabs names; mp3 at 44.1 kHz 128 kbps is on every paid plan, the others may need a higher one). */
export const ELEVENLABS_OUTPUT_FORMATS = ["mp3_44100_128", "mp3_44100_192", "mp3_44100_96", "mp3_44100_64", "pcm_24000", "pcm_44100", "pcm_48000"] as const;
export type ElevenlabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

export const ELEVENLABS_LIMITS = Object.freeze({
  maxTextChars: 10_000,
  /** ElevenLabs asks for 100-1000 characters of preview text; this default is spoken when none is given. */
  defaultPreviewText:
    "Hello, and welcome back! I'm so glad you're here. Let me tell you a little story tonight, something warm and quiet, just for the two of us.",
  previewTextMinChars: 100,
  previewTextMaxChars: 1000,
  descriptionMaxChars: 1000,
  maxPreviews: 3,
  maxAttempts: 3,
  retryBackoffMs: [30_000, 120_000],
  inFlightPerProcess: 2,
  staleSubmittingMs: 15 * 60_000,
  listMax: 50,
});

export const ELEVENLABS_OUTPUT_SUBDIR = "elevenlabs";
export const ELEVENLABS_MANIFEST_FILE = "manifest.json";

export type ElevenlabsSettings = {
  /** The owner's switch for THIS computer. Off by default. */
  enabled: boolean;
  maxCharsPerJob: number;
  maxCharsPerDay: number;
  maxCharsPerMonth: number;
  maxActiveJobs: number;
  outputFormat: ElevenlabsOutputFormat;
};

export const DEFAULT_ELEVENLABS_SETTINGS: ElevenlabsSettings = Object.freeze({
  enabled: false,
  maxCharsPerJob: 2_000,
  maxCharsPerDay: 10_000,
  maxCharsPerMonth: 30_000,
  maxActiveJobs: 5,
  outputFormat: "mp3_44100_128",
});

export const ELEVENLABS_JOB_STATUSES = ["queued", "submitting", "running", "done", "failed"] as const;
export type ElevenlabsJobStatus = (typeof ELEVENLABS_JOB_STATUSES)[number];
export const ELEVENLABS_ACTIVE_STATUSES: readonly ElevenlabsJobStatus[] = ["queued", "submitting", "running"];

/** `list_price`: ElevenLabs' characters at the list price (the subscription pays; an estimate for the spend views). */
export type ElevenlabsCostBasis = "list_price" | "not_charged" | "unknown_outcome";

export type ElevenlabsJobOutput = {
  /** Relative to the channel's `99 Data Exchange/From YTM/`: `elevenlabs/<jobId>/take-1.mp3`. */
  path: string;
  localPath: string;
  kind: "audio";
  mimeType: string;
  bytes: number;
  sha256: string;
  sampleRateHz: number | null;
  durationSeconds: number | null;
  assetId: string | null;
  note: string | null;
};

export type ElevenlabsSpeechParams = { voice: { voiceId: string; name: string; providerVoiceId: string }; outputFormat: ElevenlabsOutputFormat };
export type ElevenlabsDesignParams = { description: string; previewText: string; previews: number };

export type ElevenlabsJobView = {
  jobId: string;
  channelId: string;
  requestId: string | null;
  kind: "speech" | "voice_design";
  model: string;
  text: string;
  params: ElevenlabsSpeechParams | ElevenlabsDesignParams;
  status: ElevenlabsJobStatus;
  /** The characters this job is counted at against the limits (the text's; once charged, what ElevenLabs reported). */
  chars: number;
  chargedChars: number | null;
  estimateUsd: number;
  costUsd: number | null;
  costBasis: ElevenlabsCostBasis | null;
  outputs: ElevenlabsJobOutput[];
  error: string | null;
  errorCode: string | null;
  attempts: number;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  video: string | null;
};

export type ElevenlabsUsage = {
  /** THIS computer's characters (finished jobs' charged characters + active jobs' characters), its local day and month. */
  todayChars: number;
  monthChars: number;
  activeChars: number;
  activeJobs: number;
  /** The list-price USD of the same (an estimate; the subscription pays). */
  todayUsd: number;
  monthUsd: number;
};

export type ElevenlabsKeyView = { configured: boolean; keyHint: string | null; status: "ok" | "payment_required" | null; verifiedAt: string | null; updatedAt: string | null };

export type ElevenlabsLimitName = "per_job" | "per_day" | "per_month" | "active_jobs";

export type ElevenlabsRefusal = { code: "elevenlabs_limit_exceeded" | "elevenlabs_disabled" | "elevenlabs_key_missing" | "voice_not_approved"; message: string; details?: Record<string, unknown> };

/** The registry's resolver as this module sees it (injected; the shared `voice-registry`). */
export type ElevenlabsVoiceResolver = {
  resolve(input: { channelId: string; provider: "elevenlabs"; voice: string }): Promise<{ voiceId: string; name: string; providerVoiceId: string }>;
};

export type ElevenlabsJobManifest = {
  schema: "ytm.elevenlabs-job-manifest";
  schemaVersion: 1;
  jobId: string;
  channelId: string;
  kind: "speech";
  model: string;
  text: string;
  voice: { voiceId: string; name: string; providerVoiceId: string };
  outputFormat: string;
  status: "done";
  chars: number;
  chargedChars: number | null;
  estimateUsd: number;
  costUsd: number;
  costBasis: ElevenlabsCostBasis;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string;
  device: { deviceId: string | null; hostname: string | null };
  video: string | null;
  outputs: Array<{ path: string; kind: "audio"; mimeType: string; bytes: number; sha256: string; sampleRateHz: number | null; durationSeconds: number | null; assetId: string | null; note: string | null }>;
};

export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Characters as ElevenLabs counts them: Unicode code points (a Japanese character is one), tags included. */
export function charCount(text: string): number {
  return [...text].length;
}

export function elevenlabsJobNotFound(jobId: string): DomainError {
  return new DomainError({ code: "elevenlabs_job_not_found", message: `No ElevenLabs job ${jobId} on this computer.`, details: { jobId } });
}

export function elevenlabsInvalidParams(field: string, message: string): DomainError {
  return new DomainError({ code: "elevenlabs_invalid_params", message, details: { field } });
}
