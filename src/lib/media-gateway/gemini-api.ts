import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { jsonRequest, type JsonResponse } from "./http";
import { asNumber, asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §1.1, §2.1) -- the single funnel for Google's Gemini API
// (`generativelanguage.googleapis.com`): Nano Banana images through the Interactions API, Veo 3.1 video through
// `predictLongRunning` + its operation, the generated video's download, and a key check. Every request checks the
// "Media gateway" toggle and records a `gemini_api` traffic event first. The API key is a per-call argument (the
// `gemini-media` module decrypts it), sent only in the `x-goog-api-key` header and only to the Gemini host -- a download
// redirect to any other host is followed without it.
//
// Errors carry `details.outcome`: "answered" (Google replied), "not_sent" (the connection never reached Google: safe to
// retry, nothing charged) or "unknown" (sent, then timed out or broke: Google may have finished and charged).
// ---------------------------------------------------------------------------

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
const KEY_CHECK_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 5 * 60_000;
/** The start call uploads the frames (up to ~16 MB in base64): the same 5 minutes as an image, never a phantom timeout on a slow uplink. */
const VIDEO_START_TIMEOUT_MS = 5 * 60_000;
const VIDEO_POLL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
/** A Veo clip is at most 8 s; 500 MB is far above any real one and stops an endless stream. */
export const GEMINI_MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** Google's generation-blocked codes (Interactions API errors page) and Veo/generateContent block reasons, lower-cased. */
export const GEMINI_BLOCKED_CODES: ReadonlySet<string> = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "image_safety",
  "image_prohibited_content",
  "image_recitation",
  "image_other",
  "content_blocked",
  "no_image",
]);

/**
 * Connection failures that prove the request never reached Google (so nothing can have been charged): no address, refused,
 * unreachable, a connect timeout (undici's own, before any byte is sent), and every TLS handshake failure (review round 1).
 */
const NOT_SENT_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);

function provesNotSent(code: string): boolean {
  return NOT_SENT_CAUSES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || code.startsWith("ERR_SSL_");
}

export type GeminiOutcome = "answered" | "not_sent" | "unknown";

export type GeminiInlineImage = { mimeType: string; dataBase64: string };

export type GeminiImageRequest = {
  model: string;
  prompt: string;
  images: GeminiInlineImage[];
  aspectRatio: string;
  imageSize: string;
};

export type GeminiUsage = {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  /** Output tokens per modality (`image`, `text`, …), lower-cased; empty when Google did not split them. */
  outputByModality: Record<string, number>;
};

export type GeminiImageResult = {
  /** The final images (thought-step interim images are skipped). */
  images: Array<{ mimeType: string; data: Buffer }>;
  usage: GeminiUsage | null;
  status: string | null;
  /** A block code Google gave (lower-cased), or `null`. */
  blockReason: string | null;
};

export type GeminiVideoRequest = {
  model: string;
  prompt: string;
  firstFrame?: GeminiInlineImage;
  lastFrame?: GeminiInlineImage;
  referenceImages?: GeminiInlineImage[];
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  personGeneration?: string;
};

export type GeminiVideoOperation =
  | { done: false }
  | { done: true; videoUri: string | null; error: { code: string | null; message: string } | null; blockReason: string | null };

type Fetch = typeof fetch;

function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (typeof record.code === "string") return record.code;
  return record.cause ? errorCodeOf(record.cause) : null;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; cause?: unknown };
  if (record.name === "TimeoutError" || record.name === "AbortError") return true;
  return record.cause ? isTimeout(record.cause) : false;
}

/** The outcome of a transport failure: provably not sent, or unknown. */
export function transportOutcome(stage: "request" | "read", cause: unknown): GeminiOutcome {
  if (stage === "read" || isTimeout(cause)) return "unknown";
  const code = errorCodeOf(cause);
  return code !== null && provesNotSent(code) ? "not_sent" : "unknown";
}

/** Google's error body: `{error:{code,message}}` (Interactions: `code` a snake_case string) or the classic `{error:{code:400,status,details:[{reason}]}}`. */
function googleError(body: unknown): { code: string | null; message: string | null; reason: string | null } {
  const error = asRecord(asRecord(body).error);
  const code = asString(error.code) ?? asString(error.status);
  const details = Array.isArray(error.details) ? error.details.map(asRecord) : [];
  const reason = details.map((d) => asString(d.reason)).find((r) => r !== null) ?? null;
  return { code: code ? code.toLowerCase() : null, message: asString(error.message), reason };
}

function safeUrlForError(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

export function createGeminiApiClient(args: { fetchImpl?: Fetch; authorize?: Authorize; baseUrl?: string } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/$/, "");
  // The key goes to this exact origin only (scheme, host and port): an http:// hop to the same host never carries it.
  const geminiOrigin = new URL(baseUrl).origin;

  /** The gateway toggle first; anything else that fails before the request is sent is provably unsent (review round 1). */
  async function authorized(context: Record<string, unknown>): Promise<void> {
    try {
      await authorize("gemini_api");
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new DomainError({ code: "gemini_unavailable", message: `The request was not sent: ${error instanceof Error ? error.message : String(error)}`, details: { ...context, outcome: "not_sent" } });
    }
  }

  function unavailable(context: Record<string, unknown>) {
    return (stage: "request" | "read", detail: string, status?: number, cause?: unknown) => {
      const outcome = transportOutcome(stage, cause);
      return new DomainError({
        code: "gemini_unavailable",
        message:
          outcome === "not_sent"
            ? `The Gemini API could not be reached: ${detail}`
            : `The Gemini API request was sent but no answer was read (${detail}); Google may have completed it.`,
        details: { ...context, outcome, timedOut: isTimeout(cause), ...(status !== undefined ? { status } : {}) },
      });
    };
  }

  /** Maps an HTTP answer that is not OK to the module's error; `keyCheck` treats a 400 as a bad key (Google's `API_KEY_INVALID`). */
  function failure(response: JsonResponse, context: Record<string, unknown>, keyCheck = false): DomainError {
    const google = googleError(response.body);
    const details = { ...context, outcome: "answered" as const, status: response.status, googleCode: google.code, reason: google.reason };
    const said = google.message ? `: ${google.message.slice(0, 300)}` : "";
    if (response.status === 401 || response.status === 403 || google.reason === "API_KEY_INVALID" || (keyCheck && response.status === 400)) {
      return new DomainError({ code: "gemini_key_invalid", message: `Google refused the API key (HTTP ${response.status})${said}`, details });
    }
    if (response.status === 402) {
      return new DomainError({ code: "gemini_payment_required", message: `Google answered 402: the prepaid balance of the billing account is empty${said}`, details });
    }
    if (response.status === 429) {
      return new DomainError({ code: "gemini_rate_limited", message: `Google answered 429 (rate or quota limit)${said}`, details });
    }
    if (response.status === 408 || response.status >= 500) {
      return new DomainError({ code: "gemini_unavailable", message: `The Gemini API answered HTTP ${response.status}${said}`, details });
    }
    const blocked = google.code !== null && GEMINI_BLOCKED_CODES.has(google.code);
    return new DomainError({
      code: "gemini_request_rejected",
      message: blocked ? `Google blocked the generation (${google.code})${said}` : `The Gemini API rejected the request (HTTP ${response.status})${said}`,
      details: { ...details, blocked },
    });
  }

  async function call(
    apiKey: string,
    method: string,
    pathAndQuery: string,
    context: Record<string, unknown>,
    options: { body?: unknown; timeoutMs: number; keyCheck?: boolean }
  ): Promise<unknown> {
    await authorized(context);
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${pathAndQuery}`,
      method,
      headers: { accept: "application/json", "x-goog-api-key": apiKey, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeoutMs: options.timeoutMs,
      // The API never redirects; a redirect must not carry the key anywhere (fetch keeps custom headers across hosts).
      redirect: "error",
      unavailable: unavailable(context),
    });
    if (!response.ok) throw failure(response, context, options.keyCheck);
    return response.body;
  }

  function usageOf(value: unknown): GeminiUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    const outputByModality: Record<string, number> = {};
    for (const entry of Array.isArray(usage.output_tokens_by_modality) ? usage.output_tokens_by_modality.map(asRecord) : []) {
      const modality = asString(entry.modality);
      const tokens = asNumber(entry.tokens);
      if (modality && tokens !== null) outputByModality[modality.toLowerCase()] = (outputByModality[modality.toLowerCase()] ?? 0) + tokens;
    }
    return {
      inputTokens: asNumber(usage.total_input_tokens) ?? 0,
      outputTokens: asNumber(usage.total_output_tokens) ?? 0,
      thoughtTokens: asNumber(usage.total_thought_tokens) ?? 0,
      outputByModality,
    };
  }

  /** The final image blocks of an Interactions answer: `steps[]` (since the May 2026 revision), falling back to the legacy `outputs[]`. */
  function finalImages(body: Record<string, unknown>): Array<{ mimeType: string; data: Buffer }> {
    const blocks: Array<Record<string, unknown>> = [];
    const steps = Array.isArray(body.steps) ? body.steps.map(asRecord) : null;
    if (steps) {
      for (const step of steps) {
        if (asString(step.type) !== "model_output") continue; // thought steps hold interim images, user_input the prompt
        for (const block of Array.isArray(step.content) ? step.content.map(asRecord) : []) blocks.push(block);
      }
    } else if (Array.isArray(body.outputs)) {
      for (const block of body.outputs.map(asRecord)) blocks.push(block);
    }
    const images: Array<{ mimeType: string; data: Buffer }> = [];
    for (const block of blocks) {
      if (asString(block.type) !== "image") continue;
      const data = asString(block.data);
      if (!data) continue; // a `uri` delivery is never requested
      images.push({ mimeType: (asString(block.mime_type) ?? "image/png").toLowerCase(), data: Buffer.from(data, "base64") });
    }
    return images;
  }

  function inline(image: GeminiInlineImage) {
    return { inlineData: { mimeType: image.mimeType, data: image.dataBase64 } };
  }

  const OPERATION_NAME = /^models\/[A-Za-z0-9._-]+\/operations\/[A-Za-z0-9._-]+$/;

  return {
    /** The key check: one `models.list` page. 400/401/403 → `gemini_key_invalid`; 402 → `gemini_payment_required` (the key itself is valid). */
    async checkKey(apiKey: string): Promise<void> {
      await call(apiKey, "GET", "/v1beta/models?pageSize=1", { call: "models.list" }, { timeoutMs: KEY_CHECK_TIMEOUT_MS, keyCheck: true });
    },

    /** One Interactions call, synchronous (`store:false`: Google keeps nothing for later retrieval). */
    async generateImage(apiKey: string, request: GeminiImageRequest): Promise<GeminiImageResult> {
      const context = { call: "interactions.create", model: request.model };
      const body = asRecord(
        await call(apiKey, "POST", "/v1beta/interactions", context, {
          timeoutMs: IMAGE_TIMEOUT_MS,
          body: {
            model: request.model,
            input: [
              { type: "text", text: request.prompt },
              ...request.images.map((image) => ({ type: "image", mime_type: image.mimeType, data: image.dataBase64 })),
            ],
            response_format: { type: "image", aspect_ratio: request.aspectRatio, image_size: request.imageSize },
            store: false,
          },
        })
      );
      const errors = Array.isArray(body.errors) ? body.errors.map(asRecord) : [];
      const blockCode = errors.map((e) => asString(e.code)?.toLowerCase() ?? null).find((c) => c !== null && GEMINI_BLOCKED_CODES.has(c)) ?? null;
      return { images: finalImages(body), usage: usageOf(body.usage), status: asString(body.status), blockReason: blockCode };
    },

    /** Starts a Veo job; returns the long-running operation's name. */
    async startVideo(apiKey: string, request: GeminiVideoRequest): Promise<string> {
      const context = { call: "predictLongRunning", model: request.model };
      const instance: Record<string, unknown> = { prompt: request.prompt };
      if (request.firstFrame) instance.image = inline(request.firstFrame);
      if (request.lastFrame) instance.lastFrame = inline(request.lastFrame);
      if (request.referenceImages && request.referenceImages.length > 0) {
        instance.referenceImages = request.referenceImages.map((image) => ({ image: inline(image), referenceType: "asset" }));
      }
      const parameters: Record<string, unknown> = {
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        // Google's table gives the values as strings ("4" | "6" | "8"); proto3 JSON reads a string for an int field too.
        durationSeconds: String(request.durationSeconds),
      };
      if (request.personGeneration) parameters.personGeneration = request.personGeneration;
      const body = asRecord(
        await call(apiKey, "POST", `/v1beta/models/${encodeURIComponent(request.model)}:predictLongRunning`, context, {
          timeoutMs: VIDEO_START_TIMEOUT_MS,
          body: { instances: [instance], parameters },
        })
      );
      const name = asString(body.name);
      if (!name || !OPERATION_NAME.test(name)) {
        throw new DomainError({ code: "gemini_unavailable", message: "The Gemini API did not return a usable operation name.", details: { ...context, outcome: "unknown" } });
      }
      return name;
    },

    async getVideoOperation(apiKey: string, name: string): Promise<GeminiVideoOperation> {
      if (!OPERATION_NAME.test(name)) throw new DomainError({ code: "validation_failed", message: "Not a Veo operation name.", details: { name } });
      const body = asRecord(await call(apiKey, "GET", `/v1beta/${name}`, { call: "operations.get" }, { timeoutMs: VIDEO_POLL_TIMEOUT_MS }));
      if (body.done !== true) return { done: false };
      if (body.error !== undefined && body.error !== null) {
        const error = asRecord(body.error);
        const code = asString(error.status) ?? (asNumber(error.code) !== null ? String(asNumber(error.code)) : asString(error.code));
        return { done: true, videoUri: null, error: { code: code ? code.toLowerCase() : null, message: asString(error.message) ?? "the operation failed" }, blockReason: null };
      }
      const videoResponse = asRecord(asRecord(body.response).generateVideoResponse);
      const samples = Array.isArray(videoResponse.generatedSamples) ? videoResponse.generatedSamples.map(asRecord) : [];
      const videoUri = asString(asRecord(samples[0]?.video).uri);
      const reasons = Array.isArray(videoResponse.raiMediaFilteredReasons) ? videoResponse.raiMediaFilteredReasons.map((r) => String(r)) : [];
      const filtered = (asNumber(videoResponse.raiMediaFilteredCount) ?? 0) > 0 || reasons.length > 0;
      return { done: true, videoUri, error: null, blockReason: videoUri ? null : filtered ? reasons[0]?.slice(0, 300) || "filtered" : null };
    },

    /**
     * Streams a generated video to `destinationPath` through `<path>.part` + rename and returns its size and SHA-256.
     * Redirects are followed by hand: the key goes only to the Gemini host, never to a redirect target elsewhere; only https.
     */
    async downloadVideo(apiKey: string, uri: string, destinationPath: string): Promise<{ bytes: number; sha256: string }> {
      const context = { call: "video.download", uri: safeUrlForError(uri) };
      let url = uri;
      let response: Response | null = null;
      let lastHostIsGemini = true;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new DomainError({ code: "gemini_unavailable", message: "The video URI is not a valid URL.", details: { ...context, outcome: "answered" } });
        }
        // https only -- plain http only for the configured base itself (a local test server).
        if (parsed.protocol !== "https:" && parsed.origin !== geminiOrigin) {
          throw new DomainError({ code: "gemini_unavailable", message: "The video URI is not https; it was not followed.", details: { ...context, outcome: "answered" } });
        }
        await authorized(context);
        const toGemini = parsed.origin === geminiOrigin;
        lastHostIsGemini = toGemini;
        const headers: Record<string, string> = toGemini ? { "x-goog-api-key": apiKey } : {};
        try {
          response = await fetchImpl(parsed.toString(), { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        } catch (error) {
          throw unavailable(context)("request", error instanceof Error ? error.message : String(error), undefined, error);
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) throw new DomainError({ code: "gemini_unavailable", message: `The video download redirected (HTTP ${response.status}) without a location.`, details: { ...context, outcome: "answered" } });
          url = new URL(location, parsed).toString();
          response = null;
          continue;
        }
        break;
      }
      if (!response) throw new DomainError({ code: "gemini_unavailable", message: "The video download redirected too many times.", details: { ...context, outcome: "answered" } });
      if (!response.ok || !response.body) {
        let body: unknown = null;
        try {
          const text = await response.text();
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        // A signed storage URL that refuses is not a statement about the API key.
        if (!lastHostIsGemini && (response.status === 401 || response.status === 403)) {
          throw new DomainError({ code: "gemini_unavailable", message: `The video's storage host refused the download (HTTP ${response.status}).`, details: { ...context, outcome: "answered", status: response.status } });
        }
        throw failure({ status: response.status, ok: false, body }, context);
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > GEMINI_MAX_VIDEO_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new DomainError({ code: "gemini_unavailable", message: `The video is ${declared} bytes, over the ${GEMINI_MAX_VIDEO_BYTES}-byte limit.`, details: { ...context, outcome: "answered" } });
      }
      try {
        await mkdir(path.dirname(destinationPath), { recursive: true });
      } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
      }
      const tmpPath = `${destinationPath}.part`;
      let bytes = 0;
      const hash = createHash("sha256");
      try {
        await rm(tmpPath, { force: true });
        const counting = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > GEMINI_MAX_VIDEO_BYTES) {
              done(new DomainError({ code: "gemini_unavailable", message: `The video passed the ${GEMINI_MAX_VIDEO_BYTES}-byte limit.`, details: { ...context, outcome: "answered" } }));
              return;
            }
            hash.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), counting, createWriteStream(tmpPath, { flags: "wx" }));
        await rename(tmpPath, destinationPath);
      } catch (error) {
        await rm(tmpPath, { force: true });
        if (isDomainError(error)) throw error;
        throw unavailable(context)("read", error instanceof Error ? error.message : String(error), response.status, error);
      }
      return { bytes, sha256: hash.digest("hex") };
    },
  };
}

export type GeminiApiClient = ReturnType<typeof createGeminiApiClient>;
