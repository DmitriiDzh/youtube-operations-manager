import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md) -- images (Nano Banana) and video (Omni since BL-179; Veo until BL-180) through Google's Gemini API,
// driven by the Factory Operator within the owner's limits. A separate feature module (AGENTS.md §M): it depends on the
// media gateway (its `gemini-api.ts` child), the workspace exchange and the asset catalog, never on `media-generation`
// or `generation-plans`; switched off (the default) or without a key it makes no network call.
// ---------------------------------------------------------------------------

/** The official Gemini API pricing page these prices were copied from (§1.1): read 2026-10-09; Omni added from the page read
 * 2026-10-13 (BL-179); Omni 1.2 and the image prices re-read 2026-11-23 (owner TG 3700, https://aistudio.google.com/docs/pricing). */
export const GEMINI_PRICES_AS_OF = "2026-11-23";

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
  /** USD per second of video (with audio, the only output), by resolution; a missing resolution is not offered. This is the
   * estimate (`tokenPricing`); the cost comes from Google's token counts. Every video model is called with one synchronous
   * `POST /v1beta/interactions` whose answer carries the video (BL-179, Omni, https://ai.google.dev/gemini-api/docs/omni). */
  perSecond: Readonly<Record<string, number>>;
  referenceImages: boolean;
  /** Whether a first frame (and a last frame with it) can be given. */
  frames: boolean;
  /** Whole seconds allowed (inclusive), and the longest clip when a last frame is given too. */
  durationSeconds: { min: number; max: number; maxWithLastFrame: number };
  /** Google's announced shutdown date (YYYY-MM-DD) -- https://ai.google.dev/gemini-api/docs/deprecations. */
  retiresOn?: string;
  /** Token prices (USD per 1M), and the video tokens per second by resolution, for the estimate. */
  tokenPricing?: { inputPerM: number; textOutPerM: number; videoOutPerM: number; videoTokensPerSecond: Readonly<Record<string, number>> };
};

// Owner TG 3700: Gemini Omni 1.2 Flash (GA 2026-11-05) replaces 1.1, which Google routes to 1.2 (billed at 1.2's rates) from
// 2026-12-03 (https://aistudio.google.com/docs/deprecations). Read 2026-11-23 from https://aistudio.google.com/docs/pricing:
// input $1.50, text (and thinking) output $9.00, video output $12.00 per 1M tokens; 5,792 tokens per second of 720p and 8,688 of
// 1080p (upsampled) -- about $0.07/s and $0.104/s. (1.1, BL-179: $17.50 per 1M video tokens, 1080p guessed at 2.25 x 720p.)
// Durations from https://aistudio.google.com/docs/omni: any whole second 3-15 s (`response_format.duration`, e.g. "15s"); first +
// last frame 3-10 s ("over 10 s returns an invalid argument error"); a single image up to 15 s. The estimate gates the spend
// limits; the cost itself is Google's count.
const OMNI_TOKENS = { "720p": 5792, "1080p": 8688 };
const OMNI_VIDEO_OUT_PER_M = 12;

export const GEMINI_VIDEO_MODELS: Readonly<Record<string, GeminiVideoModelSpec>> = Object.freeze({
  "gemini-omni-1.2-flash": {
    label: "Gemini Omni 1.2 Flash",
    perSecond: Object.fromEntries(Object.entries(OMNI_TOKENS).map(([resolution, tokens]) => [resolution, (tokens * OMNI_VIDEO_OUT_PER_M) / 1_000_000])),
    referenceImages: false,
    frames: true,
    durationSeconds: { min: 3, max: 15, maxWithLastFrame: 10 },
    tokenPricing: { inputPerM: 1.5, textOutPerM: 9, videoOutPerM: OMNI_VIDEO_OUT_PER_M, videoTokensPerSecond: OMNI_TOKENS },
  },
  // BL-180: the three Veo 3.1 previews (veo-3.1-generate-preview, -fast-, -lite-) and their `predictLongRunning` transport are
  // gone -- Google shuts them down on 2026-10-22 and names Omni as the replacement (owner, Telegram msg 2902: removed now).
});

/**
 * Owner TG 3700: deprecated video model ids still accepted, each sent to Google and recorded on a new job as its replacement (the
 * Operator's workflow bundles pin `gemini-omni-1.1-flash`). Never listed as a model of its own.
 */
export const GEMINI_VIDEO_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({ "gemini-omni-1.1-flash": "gemini-omni-1.2-flash" });

/** A video model id with a deprecated alias replaced by its model (any other id unchanged). */
export function resolveGeminiVideoModel(model: string): string {
  return ownEntry(GEMINI_VIDEO_MODEL_ALIASES, model) ?? model;
}

/** The video model of an id or of a deprecated alias (a job stored before the alias was retired may carry either). */
export function geminiVideoModelSpec(model: string): GeminiVideoModelSpec | undefined {
  return ownEntry(GEMINI_VIDEO_MODELS, resolveGeminiVideoModel(model));
}

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057): speech -- one take of text in a designed voice, a third job kind next to image and video (same
// table, key, switch, limits, spend, worker and folder). Prices from the Gemini pricing page as the Operator's research R-0005
// read it on 2026-10-29: a promotional rate until 2026-12-31, then double. Audio output is billed at 25 tokens per second of audio.
// Verified on https://aistudio.google.com/docs/pricing on 2026-11-23 (owner TG 3700): 3.8 Flash TTS input $0.50 -> $1.00 and audio
// output $9.00 -> $18.00, 3.8 Flash-Lite TTS input $0.50 -> $1.00 and audio output $6.00 -> $12.00 per 1M, "starting January 1,
// 2027". (The speech request shape stays UNVERIFIED, see the gateway.)
// ---------------------------------------------------------------------------

export const GEMINI_SPEECH_PRICES_AS_OF = "2026-11-23";

/** The instant Google's announced doubling applies (UTC midnight -- the earlier reading of "from 2027-01-01", so never under-counted). */
export const GEMINI_SPEECH_PRICE_CHANGE_AT = "2027-01-01T00:00:00.000Z";

export type GeminiSpeechModelSpec = {
  label: string;
  /** USD per 1M tokens before `GEMINI_SPEECH_PRICE_CHANGE_AT`; from then on `afterChange`. */
  inputPerM: number;
  audioOutPerM: number;
  afterChange: { inputPerM: number; audioOutPerM: number };
};

/** The one list of speech models (owner msg 3815: Gemini 3.8 Flash TTS and its Lite). */
export const GEMINI_SPEECH_MODELS: Readonly<Record<string, GeminiSpeechModelSpec>> = Object.freeze({
  "gemini-3.8-flash-tts": { label: "Gemini 3.8 Flash TTS", inputPerM: 0.5, audioOutPerM: 9, afterChange: { inputPerM: 1, audioOutPerM: 18 } },
  "gemini-3.8-flash-lite-tts": { label: "Gemini 3.8 Flash-Lite TTS", inputPerM: 0.5, audioOutPerM: 6, afterChange: { inputPerM: 1, audioOutPerM: 12 } },
});

export const GEMINI_SPEECH = Object.freeze({
  /** Audio tokens per second of audio (the pricing page). */
  audioTokensPerSecond: 25,
  /**
   * The estimate's speaking rate: 5 characters per second covers Japanese (~330 characters a minute) and so over-estimates English
   * (~900 a minute) about threefold -- the estimate gates the limits; the cost is Google's count (never below the file's length).
   */
  estimateCharsPerSecond: 5,
  /**
   * Review item 9: one take must finish inside the call's timeout (`GEMINI_SPEECH_TIMEOUT_MS`, 6 min). 2,500 characters is ~2.8 min of
   * English or ~7.5 min of Japanese audio at our conservative 5 characters a second; even at real time a Japanese take this long would
   * not fit 6 minutes, so the limit errs short: a 60 s story is ~900 English / ~350 Japanese characters. Longer texts are split by the
   * Operator into takes. (Gemini TTS also caps input at about 8K tokens -- far above this.)
   */
  maxTextChars: 2500,
  maxStyleChars: 1000,
  /** The rate Gemini speaks raw PCM at when the answer does not name one (owner msg 3815: kept as delivered, no resampling). */
  defaultSampleRateHz: 24_000,
  /** Voice design: the sample text Google speaks when none is given, and its bounds. */
  defaultSampleText: "Hello! It's so nice to see you again. Let me tell you a little story.",
  maxDescriptionChars: 1000,
});

export const GEMINI_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const GEMINI_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const GEMINI_VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
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
  videoRetryMs: 30_000,
  /** Google keeps a generated video 2 days; past this the job gives up. */
  videoGiveUpMs: 47 * 3600_000,
  inFlightPerProcess: 3,
  /** A job still `submitting` this long after its claim, and not in flight here, was left by a failed write (review round 1). */
  // BL-179 (review item 3): above the longest call (an Omni video, 15 min) with a margin.
  staleSubmittingMs: 20 * 60_000,
  listMax: 50,
});

export const GEMINI_INPUT_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" });

/** The job's folder under the channel's `99 Data Exchange/From YTM/`. */
export const GEMINI_OUTPUT_SUBDIR = "gemini";
export const GEMINI_MANIFEST_FILE = "manifest.json";

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
  // Owner TG 4789: $2 (was $1) so every Omni 1.2 clip fits -- the largest, 1080p 15 s, is estimated at $1.58. Only the default:
  // a stored value (the owner's own or one received through the shared Gemini settings) is kept.
  maxUsdPerJob: 2,
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
  | "media_gateway_disabled"
  /** BL-188 stage 2: the owner cancelled the job before it was sent to Google (nothing was charged). */
  | "cancelled_by_owner";

export type GeminiInputRole = "image" | "first_frame" | "last_frame" | "reference";

export type GeminiJobInput = { role: GeminiInputRole; path: string; mimeType: string; bytes: number; sha256: string };

/** BL-236: `speech` is one take of text in a designed voice; `voice_design` records a paid voice design (never queued). */
export type GeminiJobKind = "image" | "video" | "speech" | "voice_design";

/** BL-236: the media a job kind makes, for every list that groups by media (shared jobs, video costs, spend). */
export function geminiMediaKindOf(kind: GeminiJobKind): "image" | "video" | "audio" {
  return kind === "image" ? "image" : kind === "video" ? "video" : "audio";
}

export type GeminiJobOutput = {
  /** Relative to the channel's `99 Data Exchange/From YTM/`, `/` separators: `gemini/<jobId>/image-1.png`. */
  path: string;
  localPath: string;
  kind: "image" | "video" | "audio";
  /** BL-236: an audio output's sample rate as written (Gemini: its own, kept), and its length in seconds. */
  sampleRateHz?: number | null;
  durationSeconds?: number | null;
  mimeType: string;
  bytes: number;
  sha256: string;
  assetId: string | null;
  note: string | null;
};

export type GeminiImageParams = { size: string; aspectRatio: string };
export type GeminiVideoParams = { resolution: string; aspectRatio: string; durationSeconds: number; personGeneration?: string };
/** BL-236: the approved voice a speech job speaks with (resolved from the channel's voice registry at creation), and the style. */
export type GeminiSpeechParams = { voice: { voiceId: string; name: string; providerVoiceId: string }; style: string | null };
/** BL-236: a recorded voice design: the registry voice it is for (null until the registry stores it) and Google's voice id. */
export type GeminiVoiceDesignParams = { description: string; sampleText: string; providerVoiceId: string | null };
export type GeminiJobParams = GeminiImageParams | GeminiVideoParams | GeminiSpeechParams | GeminiVoiceDesignParams;

export type GeminiJobView = {
  jobId: string;
  channelId: string;
  requestId: string | null;
  kind: GeminiJobKind;
  model: string;
  prompt: string;
  params: GeminiJobParams;
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
  /** BL-184 stage 2: the storyboard segment this video renders and the approved version it was let through on (null = none). */
  storyboard: GeminiStoryboardLink | null;
  /** BL-194 (ADR 0040): the channel's video number this job is made for (given, or its storyboard's); null = not linked. */
  video: string | null;
};

/** BL-184 stage 2 (ADR 0038 §4): what a video job records once the storyboard gate let it through with a link. */
export type GeminiStoryboardLink = { storyboardId: string; versionNumber: number; segmentId: string };

/**
 * BL-184 stage 2: the storyboard gate, injected (`./index.ts` wires the storyboards module's; this module knows nothing else about
 * storyboards, AGENTS.md §M). It lets a video job through -- with the link to record, or null -- or throws `storyboard_not_approved`.
 */
export type GeminiStoryboardGate = {
  check(input: { channelId: string; firstFrameSha256: string | null; lastFrameSha256: string | null; link: { storyboardId: string; segmentId: string } | null }): Promise<GeminiStoryboardLink | null>;
};

/**
 * BL-194 (ADR 0040): which video a new job is made for, injected (`./index.ts` wires the shared video-projects module). A given
 * number that cannot be linked throws (nothing is created or charged); an inherited one that cannot be linked gives null.
 */
export type GeminiVideoLink = {
  resolve(input: { channelId: string; videoNumber?: string | null; storyboardId?: string | null }): Promise<string | null>;
};

/**
 * BL-193 (ADR 0039): another computer that uses the SAME Gemini key (same key fingerprint), as its latest spend report shows it.
 * `todayUsd` is 0 when that report was written before this computer's local day began (its "today" is over).
 */
export type GeminiPeerSpend = { deviceId: string; hostname: string | null; todayUsd: number; monthUsd: number; updatedAt: string; stale: boolean };

/**
 * BL-193: the spend on this Gemini key across every computer that reported it -- what the daily and monthly limits are checked
 * against. `keyKnown` is false when this computer has no usable key: then nothing can be matched and only its own spend counts.
 */
export type GeminiAccountSpend = { todayUsd: number; monthUsd: number; keyKnown: boolean; otherComputers: GeminiPeerSpend[] };

/** `todayUsd`/`monthUsd`/`activeUsd`/`activeJobs`: THIS computer (unchanged since BL-174). `account` (BL-193): every computer on the key. */
export type GeminiSpend = { todayUsd: number; monthUsd: number; activeUsd: number; activeJobs: number; account: GeminiAccountSpend };

/** BL-193 (owner msg 2867: the limits are shared): the settings every computer shares. The switch stays per computer. */
export const GEMINI_SHARED_LIMIT_FIELDS = ["maxUsdPerJob", "maxUsdPerDay", "maxUsdPerMonth", "maxActiveJobs"] as const satisfies readonly (keyof GeminiMediaSettings)[];
export type GeminiSharedLimitField = (typeof GEMINI_SHARED_LIMIT_FIELDS)[number];

/** BL-193: a peer's spend report as gemini-media reads it (the sync-gateway `gemini-spend` report, structurally). */
export type GeminiPeerSpendReport = { deviceId: string; hostname: string | null; keyFingerprint: string | null; updatedAt: string; spentTodayUsd: number; spentMonthUsd: number };

export type GeminiKeyView = { configured: boolean; keyHint: string | null; status: "ok" | "payment_required" | null; verifiedAt: string | null; updatedAt: string | null };

export type GeminiLimitName = "per_job" | "per_day" | "per_month" | "active_jobs";

export type GeminiRefusal = { code: "gemini_limit_exceeded" | "gemini_disabled" | "gemini_key_missing" | "storyboard_not_approved" | "voice_not_approved"; message: string; details?: Record<string, unknown> };

/**
 * BL-236 (ADR 0057, AGENTS.md §M): the channel's voice registry as a speech job sees it, injected (`./index.ts` wires the shared
 * `voice-registry` module; this module knows nothing else about voices). Resolves a name or id to an APPROVED voice of that channel
 * and provider, or throws `voice_not_approved`.
 */
export type GeminiVoiceResolver = {
  resolve(input: { channelId: string; provider: "gemini"; voice: string }): Promise<{ voiceId: string; name: string; providerVoiceId: string }>;
};

/** The manifest written last into the job's folder (§2.4); every field copied explicitly, no key, no billing data. */
export type GeminiJobManifest = {
  schema: "ytm.gemini-job-manifest";
  schemaVersion: 1;
  jobId: string;
  channelId: string;
  kind: GeminiJobKind;
  model: string;
  prompt: string;
  params: GeminiJobParams;
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
  /** BL-194 (ADR 0040/0041): the channel's video number this job is made for (`V49`), null = not linked; its cost is `costUsd`. */
  video: string | null;
  outputs: Array<{ path: string; kind: "image" | "video" | "audio"; mimeType: string; bytes: number; sha256: string; assetId: string | null; note: string | null; sampleRateHz?: number | null; durationSeconds?: number | null }>;
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
