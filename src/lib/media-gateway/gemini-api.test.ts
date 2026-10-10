import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createGeminiApiClient, transportOutcome } from "./gemini-api";

// Expected request/response shapes come from Google's Gemini API docs as read on 2026-10-10 (GEMINI_MEDIA_PLAN.md §1.1):
// Interactions `POST /v1beta/interactions` with `response_format {type:"image", aspect_ratio, image_size}` and the answer's
// `steps[].content[]` image blocks (legacy `outputs[]` before the May 2026 revision); Veo `:predictLongRunning` with
// `instances[].{prompt,image,lastFrame,referenceImages}` as `inlineData` and `parameters`, its operation's
// `response.generateVideoResponse.generatedSamples[0].video.uri`; the key in `x-goog-api-key`; the errors page's statuses
// and codes. Not from this implementation.

type Call = { url: string; init: RequestInit };

function fakeFetch(responder: (call: Call) => Response | { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const answer = responder(call);
    if (answer instanceof Response) return answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const KEY = "AIzaTestKey-0123456789";
const headersOf = (call: Call) => call.init.headers as Record<string, string>;
const png = Buffer.from("89504e470d0a1a0a", "hex");

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

test("generateImage: one Interactions call with the text and inline images, response_format and store:false; the key only in x-goog-api-key", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      id: "v1_x",
      status: "completed",
      steps: [
        { type: "thought", summary: [{ type: "image", mime_type: "image/png", data: Buffer.from("interim").toString("base64") }] },
        { type: "model_output", content: [{ type: "text", text: "here" }, { type: "image", mime_type: "image/png", data: png.toString("base64") }] },
      ],
      usage: { total_input_tokens: 1000, total_output_tokens: 1680, total_thought_tokens: 300, output_tokens_by_modality: [{ modality: "image", tokens: 1680 }] },
    },
  }));
  const client = createGeminiApiClient({ fetchImpl, authorize: async (c) => void authorized.push(c) });
  const result = await client.generateImage(KEY, {
    model: "gemini-nano-banana-2.1",
    prompt: "a cat",
    images: [{ mimeType: "image/jpeg", dataBase64: "AAAA" }],
    aspectRatio: "16:9",
    imageSize: "2K",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(headersOf(calls[0])["x-goog-api-key"], KEY);
  assert.ok(!calls[0].url.includes(KEY), "the key is never in the URL");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: "gemini-nano-banana-2.1",
    input: [
      { type: "text", text: "a cat" },
      { type: "image", mime_type: "image/jpeg", data: "AAAA" },
    ],
    response_format: { type: "image", aspect_ratio: "16:9", image_size: "2K" },
    store: false,
  });
  assert.deepEqual(authorized, ["gemini_api"]);
  // The thought step's interim image is skipped; the final one is returned.
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.deepEqual(result.images[0].data, png);
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: { image: 1680 } });
  assert.equal(result.blockReason, null);
});

test("generateImage reads the legacy outputs[] shape too", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { status: "completed", outputs: [{ type: "image", mime_type: "image/jpeg", data: png.toString("base64") }] } }));
  const result = await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).generateImage(KEY, { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" });
  assert.deepEqual(result.images.map((i) => i.mimeType), ["image/jpeg"]);
  assert.equal(result.usage, null);
});

test("generateImage: a failed answer with a blocked errors[] code reports the block reason and no image", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { status: "failed", steps: [], errors: [{ code: "IMAGE_SAFETY", message: "blocked" }] } }));
  const result = await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).generateImage(KEY, { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" });
  assert.deepEqual([result.images.length, result.status, result.blockReason], [0, "failed", "image_safety"]);
});

test("HTTP errors map to the module's codes with outcome 'answered' (errors page: 400/401/402/403/429/5xx)", async () => {
  const cases: Array<[number, unknown, string, Record<string, unknown>?]> = [
    [400, { error: { code: "image_safety", message: "no" } }, "gemini_request_rejected", { blocked: true }],
    [400, { error: { code: "invalid_request", message: "bad field" } }, "gemini_request_rejected", { blocked: false }],
    [400, { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, "gemini_key_invalid"],
    [401, { error: { code: "authentication" } }, "gemini_key_invalid"],
    [403, { error: { code: "permission_denied" } }, "gemini_key_invalid"],
    [402, { error: { code: "payment_required" } }, "gemini_payment_required"],
    [404, { error: { code: "model_not_found" } }, "gemini_request_rejected", { blocked: false }],
    [408, null, "gemini_unavailable"],
    [429, { error: { code: "rate_limit_exceeded" } }, "gemini_rate_limited"],
    [500, { error: { code: "api_error" } }, "gemini_unavailable"],
    [503, { raw: "x" }, "gemini_unavailable"],
  ];
  for (const [status, body, code, extra] of cases) {
    const { fetchImpl } = fakeFetch(() => ({ status, body }));
    const details = await expectError(createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).generateImage(KEY, { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" }), code);
    assert.equal(details.outcome, "answered", `${status}`);
    assert.equal(details.status, status);
    for (const [k, v] of Object.entries(extra ?? {})) assert.equal(details[k], v, `${status} ${k}`);
  }
});

test("transport failures: a refused connection is 'not_sent'; a timeout or any other break after sending is 'unknown'", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(transportOutcome("request", refused), "not_sent");
  assert.equal(transportOutcome("request", reset), "unknown");
  assert.equal(transportOutcome("request", timeout), "unknown");
  assert.equal(transportOutcome("read", refused), "unknown", "a body that broke after headers: the call was answered");
  const fetchImpl = (async () => {
    throw timeout;
  }) as typeof fetch;
  const details = await expectError(createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).generateImage(KEY, { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" }), "gemini_unavailable");
  assert.deepEqual([details.outcome, details.timedOut], ["unknown", true]);
});

test("the media gateway toggle is checked before any request: a refusal stops the call", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = createGeminiApiClient({
    fetchImpl,
    authorize: async () => {
      throw Object.assign(new Error("off"), { code: "media_gateway_disabled", name: "DomainError" });
    },
  });
  await assert.rejects(client.checkKey(KEY));
  assert.equal(calls.length, 0);
});

test("checkKey lists one model page; a 400 counts as a bad key on this path, 402 as an empty balance", async () => {
  const ok = fakeFetch(() => ({ status: 200, body: { models: [] } }));
  await createGeminiApiClient({ fetchImpl: ok.fetchImpl, authorize: async () => undefined }).checkKey(KEY);
  assert.equal(ok.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
  assert.equal(ok.calls[0].init.method, "GET");
  assert.equal(headersOf(ok.calls[0])["x-goog-api-key"], KEY);
  const bad = fakeFetch(() => ({ status: 400, body: { error: { code: 400, message: "API key not valid." } } }));
  await expectError(createGeminiApiClient({ fetchImpl: bad.fetchImpl, authorize: async () => undefined }).checkKey(KEY), "gemini_key_invalid");
  const empty = fakeFetch(() => ({ status: 402, body: { error: { code: "payment_required" } } }));
  await expectError(createGeminiApiClient({ fetchImpl: empty.fetchImpl, authorize: async () => undefined }).checkKey(KEY), "gemini_payment_required");
});

test("startVideo: predictLongRunning with instances[0] (prompt, image, lastFrame as inlineData) and parameters; returns the operation name", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { name: "models/veo-3.1-fast-generate-preview/operations/abc123" } }));
  const name = await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).startVideo(KEY, {
    model: "veo-3.1-fast-generate-preview",
    prompt: "waves",
    firstFrame: { mimeType: "image/png", dataBase64: "Zmlyc3Q=" },
    lastFrame: { mimeType: "image/jpeg", dataBase64: "bGFzdA==" },
    aspectRatio: "9:16",
    resolution: "1080p",
    durationSeconds: 8,
  });
  assert.equal(name, "models/veo-3.1-fast-generate-preview/operations/abc123");
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    instances: [
      {
        prompt: "waves",
        image: { inlineData: { mimeType: "image/png", data: "Zmlyc3Q=" } },
        lastFrame: { inlineData: { mimeType: "image/jpeg", data: "bGFzdA==" } },
      },
    ],
    parameters: { aspectRatio: "9:16", resolution: "1080p", durationSeconds: "8" },
  });
});

test("startVideo: reference images are sent as {image:{inlineData}, referenceType:'asset'}; personGeneration only when given", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { name: "models/veo-3.1-generate-preview/operations/r1" } }));
  await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).startVideo(KEY, {
    model: "veo-3.1-generate-preview",
    prompt: "p",
    referenceImages: [{ mimeType: "image/png", dataBase64: "QQ==" }],
    aspectRatio: "16:9",
    resolution: "720p",
    durationSeconds: 8,
    personGeneration: "allow_adult",
  });
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.instances[0].referenceImages, [{ image: { inlineData: { mimeType: "image/png", data: "QQ==" } }, referenceType: "asset" }]);
  assert.equal(body.parameters.personGeneration, "allow_adult");
});

test("startVideo refuses an answer without a well-formed operation name (outcome unknown: the job may exist)", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { name: "../../evil" } }));
  const details = await expectError(createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).startVideo(KEY, { model: "m", prompt: "p", aspectRatio: "16:9", resolution: "720p", durationSeconds: 4 }), "gemini_unavailable");
  assert.equal(details.outcome, "unknown");
});

test("getVideoOperation: not done; done with a video uri; done with an error; done with no sample (filtered)", async () => {
  const answers = [
    { name: "models/v/operations/o", done: false },
    { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media" } }] } } },
    { done: true, error: { code: 3, status: "INVALID_ARGUMENT", message: "bad" } },
    { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["child safety"] } } },
  ];
  let i = 0;
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: answers[i++] }));
  const client = createGeminiApiClient({ fetchImpl, authorize: async () => undefined });
  assert.deepEqual(await client.getVideoOperation(KEY, "models/v/operations/o"), { done: false });
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/v/operations/o");
  assert.deepEqual(await client.getVideoOperation(KEY, "models/v/operations/o"), { done: true, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media", error: null, blockReason: null });
  assert.deepEqual(await client.getVideoOperation(KEY, "models/v/operations/o"), { done: true, videoUri: null, error: { code: "invalid_argument", message: "bad" }, blockReason: null });
  assert.deepEqual(await client.getVideoOperation(KEY, "models/v/operations/o"), { done: true, videoUri: null, error: null, blockReason: "child safety" });
  await assert.rejects(client.getVideoOperation(KEY, "models/v/operations/o/../../x"));
  assert.equal(calls.length, 4, "a malformed name is never requested");
});

test("downloadVideo follows a redirect by hand: the key goes to the Gemini host only, the file lands via .part with its SHA-256", async () => {
  const video = Buffer.from("fake mp4 bytes ".repeat(1000));
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (call.url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(null, { status: 302, headers: { location: "https://storage.example.com/signed?sig=1" } });
    return new Response(video, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(video.length) } });
  });
  const dir = await mkdtemp(path.join(tmpdir(), "gemini-dl-"));
  try {
    const dest = path.join(dir, "job", "video-1.mp4");
    const result = await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).downloadVideo(KEY, "https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media", dest);
    assert.deepEqual(result, { bytes: video.length, sha256: createHash("sha256").update(video).digest("hex") });
    assert.deepEqual(await readFile(dest), video);
    assert.deepEqual(await readdir(path.dirname(dest)), ["video-1.mp4"], "no .part left");
    assert.equal(headersOf(calls[0])["x-goog-api-key"], KEY);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(headersOf(calls[1])["x-goog-api-key"], undefined, "the redirect target never gets the key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadVideo refuses a plain-http URI on another host and never sends the key there", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
  await expectError(createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).downloadVideo(KEY, "http://evil.example.com/v.mp4", "/tmp/never"), "gemini_unavailable");
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------------------------------------- review round 1 additions

test("review 1: TLS and connect-timeout failures prove nothing was sent; a failure before the request is 'not_sent' too", async () => {
  const wrap = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
    assert.equal(transportOutcome("request", wrap(code)), "not_sent", code);
  }
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = createGeminiApiClient({
    fetchImpl,
    authorize: async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    },
  });
  const details = await expectError(client.generateImage(KEY, { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" }), "gemini_unavailable");
  assert.equal(details.outcome, "not_sent");
  assert.equal(calls.length, 0);
});

test("review 1: API calls never follow a redirect (the key header would follow it to any host)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { models: [] } }));
  await createGeminiApiClient({ fetchImpl, authorize: async () => undefined }).checkKey(KEY);
  assert.equal(calls[0].init.redirect, "error");
});

test("review 1: a download hop to http:// on the Gemini host is refused (no key in clear); a storage host's 403 is not a key verdict", async () => {
  const toHttp = fakeFetch(() => new Response(null, { status: 302, headers: { location: "http://generativelanguage.googleapis.com/v1beta/files/f" } }));
  await expectError(createGeminiApiClient({ fetchImpl: toHttp.fetchImpl, authorize: async () => undefined }).downloadVideo(KEY, "https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", "/tmp/never"), "gemini_unavailable");
  assert.equal(toHttp.calls.length, 1, "the http hop is never requested");
  const storage = fakeFetch((call) =>
    call.url.startsWith("https://generativelanguage.googleapis.com/") ? new Response(null, { status: 302, headers: { location: "https://storage.example.com/x" } }) : new Response("denied", { status: 403 })
  );
  const details = await expectError(createGeminiApiClient({ fetchImpl: storage.fetchImpl, authorize: async () => undefined }).downloadVideo(KEY, "https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", "/tmp/never"), "gemini_unavailable");
  assert.equal(details.status, 403);
});

// ------------------------------------------------------------------------------------------------- review round 2 additions

test("review 2: only named handshake/certificate failures are 'not_sent'; a TLS record error on an open connection is 'unknown'", async () => {
  const wrap = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  for (const code of ["ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_SSL_WRONG_VERSION_NUMBER", "CERT_NOT_YET_VALID"]) assert.equal(transportOutcome("request", wrap(code)), "not_sent", code);
  for (const code of ["ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", "ERR_TLS_INVALID_STATE", "ECONNRESET", "EPIPE"]) assert.equal(transportOutcome("request", wrap(code)), "unknown", code);
});

test("review 2: token counts may be decimal strings; a usage object with no readable documented count is no counts at all", async () => {
  const answers = [
    { status: "completed", steps: [], usage: { total_input_tokens: "1000", total_output_tokens: "0", total_thought_tokens: "300" } },
    { status: "completed", steps: [], usage: { input_tokens: 1000, something: "x" } },
    { status: "completed", steps: [], usage: { total_input_tokens: -5, total_output_tokens: 1.5 } },
  ];
  let i = 0;
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: answers[i++] }));
  const client = createGeminiApiClient({ fetchImpl, authorize: async () => undefined });
  const request = { model: "m", prompt: "p", images: [], aspectRatio: "1:1", imageSize: "1K" };
  assert.deepEqual((await client.generateImage(KEY, request)).usage, { inputTokens: 1000, outputTokens: 0, thoughtTokens: 300, outputByModality: {} });
  assert.equal((await client.generateImage(KEY, request)).usage, null, "renamed fields are not counts");
  assert.equal((await client.generateImage(KEY, request)).usage, null, "negative or fractional values are not counts");
});
