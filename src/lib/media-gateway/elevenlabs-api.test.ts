import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createElevenlabsApiClient } from "./elevenlabs-api";

// BL-236 (ADR 0057): request and answer shapes from ElevenLabs' public API reference as R-0005 cites it (UNVERIFIED by a call):
// text-to-speech `POST /v1/text-to-speech/{voice_id}?output_format=` with `{ text, model_id }` answering audio bytes; Voice Design
// `POST /v1/text-to-voice/design` with `{ voice_description, model_id: eleven_ttv_v3, text | auto_generate_text }` answering
// `previews[].{ audio_base_64, generated_voice_id, media_type, duration_secs }`; `POST /v1/text-to-voice` saving one; the key in
// `xi-api-key`; `{ detail: { status, message } }` errors. Not from this implementation.

type Call = { url: string; init: RequestInit };
const KEY = "sk_test_0123456789abcdef0123";

function fakeFetch(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function expectError(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error), String(error));
    assert.equal(error.code, code, error.message);
    return (error.details ?? {}) as Record<string, unknown>;
  }
  assert.fail(`expected ${code}`);
}

test("textToSpeech: POST /v1/text-to-speech/{voice} with output_format, { text, model_id }; the key only in xi-api-key; audio bytes and the charged characters back", async () => {
  const mp3 = Buffer.from("ID3-mp3-bytes");
  const authorized: string[] = [];
  const { fetchImpl, calls } = fakeFetch(() => new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg", "character-cost": "42", "request-id": "req-1" } }));
  const api = createElevenlabsApiClient({ fetchImpl, authorize: async (c) => void authorized.push(c) });
  const result = await api.textToSpeech(KEY, { voiceId: "voice/1", text: "[whispers] Hello", modelId: "eleven_v4", outputFormat: "mp3_44100_128" });
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["xi-api-key"], KEY);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: "[whispers] Hello", model_id: "eleven_v4" });
  assert.deepEqual(authorized, ["elevenlabs_api"]);
  assert.deepEqual(result.audio, { mimeType: "audio/mpeg", data: mp3 });
  assert.equal(result.chargedChars, 42);
});

test("textToSpeech errors: 401 key, quota_exceeded payment, 429 rate, 500 unavailable, a moderation refusal is blocked; a gateway switch-off is never sent", async () => {
  const cases: Array<[Response, string]> = [
    [json(401, { detail: { status: "invalid_api_key", message: "bad" } }), "elevenlabs_key_invalid"],
    [json(401, { detail: { status: "quota_exceeded", message: "no characters left" } }), "elevenlabs_payment_required"],
    [json(429, { detail: { status: "too_many_concurrent_requests" } }), "elevenlabs_rate_limited"],
    [json(500, { detail: "boom" }), "elevenlabs_unavailable"],
    [json(400, { detail: { status: "content_against_moderation_policy" } }), "elevenlabs_request_rejected"],
  ];
  for (const [response, code] of cases) {
    const { fetchImpl } = fakeFetch(() => response);
    const api = createElevenlabsApiClient({ fetchImpl, authorize: async () => undefined });
    const details = await expectError(api.textToSpeech(KEY, { voiceId: "v", text: "t", modelId: "m", outputFormat: "mp3_44100_128" }), code);
    assert.equal(details.outcome, "answered");
    if (code === "elevenlabs_request_rejected") assert.equal(details.blocked, true);
  }
  const { fetchImpl, calls } = fakeFetch(() => json(200, {}));
  const off = createElevenlabsApiClient({ fetchImpl, authorize: async () => { throw new (await import("@/lib/shared-domain")).DomainError({ code: "media_gateway_disabled", message: "off" }); } });
  await expectError(off.textToSpeech(KEY, { voiceId: "v", text: "t", modelId: "m", outputFormat: "mp3_44100_128" }), "media_gateway_disabled");
  assert.equal(calls.length, 0);
});

test("textToSpeech: a connection refused is not_sent (safe to retry); a 200 with JSON is an unknown outcome, never saved as audio", async () => {
  const refused = createElevenlabsApiClient({
    fetchImpl: (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch,
    authorize: async () => undefined,
  });
  assert.equal((await expectError(refused.textToSpeech(KEY, { voiceId: "v", text: "t", modelId: "m", outputFormat: "x" }), "elevenlabs_unavailable")).outcome, "not_sent");
  const { fetchImpl } = fakeFetch(() => json(200, { detail: "odd" }));
  const api = createElevenlabsApiClient({ fetchImpl, authorize: async () => undefined });
  assert.equal((await expectError(api.textToSpeech(KEY, { voiceId: "v", text: "t", modelId: "m", outputFormat: "x" }), "elevenlabs_unavailable")).outcome, "unknown");
});

test("designVoice: POST /v1/text-to-voice/design with the description and eleven_ttv_v3; previews parsed; no text → auto_generate_text", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    json(200, {
      previews: [
        { audio_base_64: Buffer.from("A1").toString("base64"), generated_voice_id: "gen1", media_type: "audio/mpeg", duration_secs: 4.5 },
        { audio_base_64: Buffer.from("A2").toString("base64"), generated_voice_id: "gen2", media_type: "audio/mpeg", duration_secs: 4.1 },
      ],
      text: "Hello from the design",
    })
  );
  const api = createElevenlabsApiClient({ fetchImpl, authorize: async () => undefined });
  const result = await api.designVoice(KEY, { description: "young adult woman, soft warm voice", text: null, modelId: "eleven_ttv_v3", outputFormat: "mp3_44100_128" });
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_128");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { voice_description: "young adult woman, soft warm voice", model_id: "eleven_ttv_v3", auto_generate_text: true });
  assert.deepEqual(result.previews.map((p) => [p.generatedVoiceId, p.mimeType, String(p.data), p.durationSeconds]), [["gen1", "audio/mpeg", "A1", 4.5], ["gen2", "audio/mpeg", "A2", 4.1]]);
});

test("createVoiceFromDesign saves the chosen preview (POST /v1/text-to-voice) and answers its voice_id; getSubscription reads the character usage", async () => {
  const { fetchImpl, calls } = fakeFetch((call) =>
    call.url.endsWith("/v1/text-to-voice") ? json(200, { voice_id: "voice_sumire" }) : json(200, { tier: "starter", character_count: 1234, character_limit: 30000, next_character_count_reset_unix: 1_798_761_600 })
  );
  const api = createElevenlabsApiClient({ fetchImpl, authorize: async () => undefined });
  assert.deepEqual(await api.createVoiceFromDesign(KEY, { name: "Sumire", description: "soft", generatedVoiceId: "gen2" }), { voiceId: "voice_sumire" });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { voice_name: "Sumire", voice_description: "soft", generated_voice_id: "gen2" });
  assert.deepEqual(await api.getSubscription(KEY), { tier: "starter", characterCount: 1234, characterLimit: 30000, nextResetAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(calls[1].url, "https://api.elevenlabs.io/v1/user/subscription");
});
