import { DomainError, isDomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { transportOutcome } from "./gemini-api";
import { jsonRequest, type JsonResponse } from "./http";
import { asNumber, asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057) -- the single funnel for ElevenLabs' API (`api.elevenlabs.io`): one speech take in a saved
// voice, a voice designed from a text description (Voice Design v3) and saving one of its previews as a voice, and the
// subscription's character usage (also the key check). Every request checks the "Media gateway" toggle and records an
// `elevenlabs_api` traffic event first. The API key is a per-call argument (the `elevenlabs-speech` module decrypts it), sent
// only in the `xi-api-key` header and only to this exact origin; no redirect is followed.
//
// UNVERIFIED (no call was made while building; the owner makes the first paid one): the endpoints and field names follow the
// Operator's research R-0005 and ElevenLabs' public API reference as it describes them -- `POST /v1/text-to-speech/{voice_id}`
// (`text`, `model_id`, `?output_format=`), `POST /v1/text-to-voice/design` (`voice_description`, `model_id: eleven_ttv_v3`,
// `text` / `auto_generate_text`; answer `previews[].{audio_base_64, generated_voice_id, media_type, duration_secs}`),
// `POST /v1/text-to-voice` (`voice_name`, `voice_description`, `generated_voice_id` → `voice_id`) and
// `GET /v1/user/subscription` (`tier`, `character_count`, `character_limit`, `next_character_count_reset_unix`). The parsers
// accept camelCase twins and missing fields.
//
// Deliberately absent: any voice cloning (the voices "add" endpoint, instant or professional cloning, speech-to-speech). The owner
// allows designed voices only; `no-clone.test.ts` fails the suite if such a function appears in any gateway child.
//
// Errors carry `details.outcome` like the Gemini child: "answered", "not_sent" (provably never reached ElevenLabs) or "unknown".
// ---------------------------------------------------------------------------

export const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io";
const KEY_CHECK_TIMEOUT_MS = 30_000;
export const ELEVENLABS_SPEECH_TIMEOUT_MS = 3 * 60_000;
/** A 10,000-character take is a few minutes of audio; 100 MB is far above any real answer and stops an endless stream. */
export const ELEVENLABS_MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export type ElevenlabsSpeechRequest = { voiceId: string; text: string; modelId: string; outputFormat: string };

export type ElevenlabsSpeechResult = {
  audio: { mimeType: string; data: Buffer };
  /** The characters ElevenLabs says it charged (its `character-cost` / `x-character-count` header), or null when it gave none. */
  chargedChars: number | null;
  requestId: string | null;
};

export type ElevenlabsVoiceDesignRequest = { description: string; text: string | null; modelId: string; outputFormat: string };

export type ElevenlabsVoiceDesignResult = {
  previews: Array<{ generatedVoiceId: string; mimeType: string; data: Buffer; durationSeconds: number | null }>;
  /** The text the previews speak (ElevenLabs' own when it generated it). */
  text: string | null;
};

export type ElevenlabsSubscription = { tier: string | null; characterCount: number | null; characterLimit: number | null; nextResetAt: string | null };

type Fetch = typeof fetch;

/** ElevenLabs' error body: `{ detail: { status, message } }` or `{ detail: "text" }`. */
function elevenlabsError(body: unknown): { status: string | null; message: string | null } {
  const detail = asRecord(body).detail;
  if (typeof detail === "string") return { status: null, message: detail };
  const record = asRecord(detail);
  return { status: asString(record.status)?.toLowerCase() ?? asString(record.code)?.toLowerCase() ?? null, message: asString(record.message) };
}

const PAYMENT_STATUSES = new Set(["quota_exceeded", "insufficient_credits", "payment_required", "subscription_required", "free_users_not_allowed"]);
const BLOCKED_MARKERS = ["moderation", "blocked", "safety", "violat", "terms"];

function count(value: unknown): number | null {
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) return Number(value);
  const n = asNumber(value);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

export function createElevenlabsApiClient(args: { fetchImpl?: Fetch; authorize?: Authorize; baseUrl?: string } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? ELEVENLABS_API_BASE_URL).replace(/\/$/, "");

  async function authorized(context: Record<string, unknown>): Promise<void> {
    try {
      await authorize("elevenlabs_api");
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new DomainError({ code: "elevenlabs_unavailable", message: `The request was not sent: ${error instanceof Error ? error.message : String(error)}`, details: { ...context, outcome: "not_sent" } });
    }
  }

  function unavailable(context: Record<string, unknown>) {
    return (stage: "request" | "read", detail: string, status?: number, cause?: unknown) => {
      const outcome = transportOutcome(stage, cause);
      return new DomainError({
        code: "elevenlabs_unavailable",
        message: outcome === "not_sent" ? `ElevenLabs could not be reached: ${detail}` : `The ElevenLabs request was sent but no answer was read (${detail}); it may have been completed and charged.`,
        details: { ...context, outcome, ...(status !== undefined ? { status } : {}) },
      });
    };
  }

  function failure(response: { status: number; body: unknown }, context: Record<string, unknown>): DomainError {
    const said = elevenlabsError(response.body);
    const details = { ...context, outcome: "answered" as const, status: response.status, providerStatus: said.status };
    const text = said.message ? `: ${said.message.slice(0, 300)}` : "";
    if (response.status === 402 || (said.status !== null && PAYMENT_STATUSES.has(said.status))) {
      return new DomainError({ code: "elevenlabs_payment_required", message: `ElevenLabs refused for the plan or its characters (HTTP ${response.status})${text}`, details });
    }
    if (response.status === 401 || response.status === 403) return new DomainError({ code: "elevenlabs_key_invalid", message: `ElevenLabs refused the API key (HTTP ${response.status})${text}`, details });
    if (response.status === 429) return new DomainError({ code: "elevenlabs_rate_limited", message: `ElevenLabs answered 429 (rate or concurrency limit)${text}`, details });
    if (response.status === 408 || response.status >= 500) return new DomainError({ code: "elevenlabs_unavailable", message: `ElevenLabs answered HTTP ${response.status}${text}`, details });
    const blocked = BLOCKED_MARKERS.some((marker) => (said.status ?? "").includes(marker));
    return new DomainError({ code: "elevenlabs_request_rejected", message: `ElevenLabs rejected the request (HTTP ${response.status})${text}`, details: { ...details, blocked } });
  }

  async function callJson(apiKey: string, method: string, pathAndQuery: string, context: Record<string, unknown>, options: { body?: unknown; timeoutMs: number }): Promise<Record<string, unknown>> {
    await authorized(context);
    const response: JsonResponse = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${pathAndQuery}`,
      method,
      headers: { accept: "application/json", "xi-api-key": apiKey, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeoutMs: options.timeoutMs,
      redirect: "error",
      unavailable: unavailable(context),
    });
    if (!response.ok) throw failure(response, context);
    return asRecord(response.body);
  }

  return {
    /** The key check and the account's character usage in one free read. 401/403 → `elevenlabs_key_invalid`. */
    async getSubscription(apiKey: string): Promise<ElevenlabsSubscription> {
      const body = await callJson(apiKey, "GET", "/v1/user/subscription", { call: "user.subscription" }, { timeoutMs: KEY_CHECK_TIMEOUT_MS });
      const reset = count(body.next_character_count_reset_unix ?? body.nextCharacterCountResetUnix);
      return {
        tier: asString(body.tier),
        characterCount: count(body.character_count ?? body.characterCount),
        characterLimit: count(body.character_limit ?? body.characterLimit),
        nextResetAt: reset !== null ? new Date(reset * 1000).toISOString() : null,
      };
    },

    /** One take in a saved voice; the answer is the audio itself (binary). Never retried here. */
    async textToSpeech(apiKey: string, request: ElevenlabsSpeechRequest): Promise<ElevenlabsSpeechResult> {
      const context = { call: "text_to_speech", model: request.modelId, outputFormat: request.outputFormat };
      await authorized(context);
      const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${encodeURIComponent(request.outputFormat)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { accept: "audio/*, application/json", "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({ text: request.text, model_id: request.modelId }),
          redirect: "error",
          signal: AbortSignal.timeout(ELEVENLABS_SPEECH_TIMEOUT_MS),
        });
      } catch (error) {
        throw unavailable(context)("request", error instanceof Error ? error.message : String(error), undefined, error);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw unavailable(context)("read", error instanceof Error ? error.message : String(error), response.status, error);
      }
      if (!response.ok || contentType.includes("application/json")) {
        let body: unknown = null;
        try {
          body = JSON.parse(data.toString("utf8"));
        } catch {
          body = null;
        }
        if (response.ok) throw new DomainError({ code: "elevenlabs_unavailable", message: "ElevenLabs answered with JSON, not audio; it may have been charged.", details: { ...context, outcome: "unknown", status: response.status } });
        throw failure({ status: response.status, body }, context);
      }
      if (data.length > ELEVENLABS_MAX_AUDIO_BYTES) throw new DomainError({ code: "elevenlabs_unavailable", message: `The audio is ${data.length} bytes, over the limit.`, details: { ...context, outcome: "answered" } });
      const charged = count(response.headers.get("character-cost") ?? response.headers.get("x-character-count"));
      return { audio: { mimeType: contentType.split(";")[0] || "audio/mpeg", data }, chargedChars: charged, requestId: response.headers.get("request-id") };
    },

    /** Voice Design v3: previews of a voice made from a description (no audio is sent: designed, never cloned). */
    async designVoice(apiKey: string, request: ElevenlabsVoiceDesignRequest): Promise<ElevenlabsVoiceDesignResult> {
      const body = await callJson(apiKey, "POST", `/v1/text-to-voice/design?output_format=${encodeURIComponent(request.outputFormat)}`, { call: "text_to_voice.design", model: request.modelId }, {
        timeoutMs: ELEVENLABS_SPEECH_TIMEOUT_MS,
        body: { voice_description: request.description, model_id: request.modelId, ...(request.text ? { text: request.text } : { auto_generate_text: true }) },
      });
      const previews: ElevenlabsVoiceDesignResult["previews"] = [];
      for (const preview of Array.isArray(body.previews) ? body.previews.map(asRecord) : []) {
        const id = asString(preview.generated_voice_id) ?? asString(preview.generatedVoiceId);
        const audio = asString(preview.audio_base_64) ?? asString(preview.audioBase64);
        if (!id || !audio) continue;
        previews.push({ generatedVoiceId: id, mimeType: (asString(preview.media_type) ?? asString(preview.mediaType) ?? "audio/mpeg").toLowerCase(), data: Buffer.from(audio, "base64"), durationSeconds: asNumber(preview.duration_secs ?? preview.durationSecs) });
      }
      return { previews, text: asString(body.text) };
    },

    /** Saves one designed preview as a voice of the account; answers its `voice_id`. */
    async createVoiceFromDesign(apiKey: string, request: { name: string; description: string; generatedVoiceId: string }): Promise<{ voiceId: string }> {
      const body = await callJson(apiKey, "POST", "/v1/text-to-voice", { call: "text_to_voice.create" }, {
        timeoutMs: KEY_CHECK_TIMEOUT_MS,
        body: { voice_name: request.name, voice_description: request.description, generated_voice_id: request.generatedVoiceId },
      });
      const voiceId = asString(body.voice_id) ?? asString(body.voiceId);
      if (!voiceId) throw new DomainError({ code: "elevenlabs_unavailable", message: "ElevenLabs saved the voice but gave no voice_id.", details: { outcome: "answered" } });
      return { voiceId };
    },
  };
}

export type ElevenlabsApiClient = ReturnType<typeof createElevenlabsApiClient>;
