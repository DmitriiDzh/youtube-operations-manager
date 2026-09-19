import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleAdapter, type FetchLike } from "./openai-compatible";
import type { AiConnection } from "../contracts";

function makeConnection(overrides: Partial<AiConnection> = {}): AiConnection {
  return {
    id: "conn-1",
    displayName: "Test",
    adapterType: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    modelId: "some-model",
    localInferenceMode: false,
    enabled: true,
    status: "unknown",
    statusMessage: null,
    statusCheckedAt: null,
    capabilities: { structuredOutput: "json_object" },
    assignedTasks: ["ai_localization"],
    pricing: null,
    hasCredential: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const REQUEST = { videoId: "v1", targetLanguage: "es", sourceLanguage: "en", sourceTitle: "Cats", sourceDescription: "A tour." };

// INV-AIC-7: no automated test in this repository may perform a real DNS lookup (or
// any other real network call). `validateEndpointUrl` resolves hostnames via DNS by
// default, so every test that isn't specifically exercising DNS-based blocking
// (endpoint-security.test.ts's AC-CONN-09) must inject a mocked resolver here --
// otherwise these tests would silently depend on outbound network access.
const PUBLIC_DNS_LOOKUP = async () => [{ address: "8.8.8.8", family: 4 }];

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

// AC-CONN-11
test("AC-CONN-11: a 200 response with malformed (non-JSON) body is reported as a provider error, never thrown uncaught", async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); }, async text() { return "not json"; } });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(outcome.status, "error");
});

test("AC-CONN-11: a 200 response whose JSON is missing title/description is reported as a provider error", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ foo: "bar" }) } }] });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(outcome.status, "error");
});

test("a well-formed response is parsed into a valid ok outcome with usage", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify({ title: "Gatos", description: "Un tour." }) } }],
      usage: { prompt_tokens: 42, completion_tokens: 8 },
    });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome, usage } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.deepEqual(outcome, { status: "ok", title: "Gatos", description: "Un tour." });
  assert.deepEqual(usage, { inputTokens: 42, outputTokens: 8 });
});

// AC-CONN-12
test("AC-CONN-12: a provider timeout is bounded and reported, not hung indefinitely", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, timeoutMs: 50, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(outcome.status, "error");
  assert.equal((outcome as { message: string }).message, "timeout");
});

// AC-CONN-16
test("AC-CONN-16: a response with no usage field reports usage as null (unknown), never zero", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ title: "T", description: "D" }) } }] });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { usage } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(usage, null);
});

test("a non-2xx HTTP status is reported as a provider error", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse(400, { error: "bad request" });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(outcome.status, "error");
});

test("capability 'none' rejects before any fetch call", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    throw new Error("must not be called");
  };
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  await assert.rejects(
    adapter.generate({ connection: makeConnection({ capabilities: { structuredOutput: "none" } }), credential: null, request: REQUEST })
  );
  assert.equal(called, false);
});

test("endpoint validation rejects a private-network base URL before any fetch call", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    throw new Error("must not be called");
  };
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  await assert.rejects(
    adapter.generate({
      connection: makeConnection({ baseUrl: "http://192.168.1.5:8000/v1", localInferenceMode: false }),
      credential: null,
      request: REQUEST,
    })
  );
  assert.equal(called, false);
});

test("localInferenceMode: true permits a private-network base URL", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ title: "T", description: "D" }) } }] });
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({
    connection: makeConnection({ baseUrl: "http://192.168.1.5:8000/v1", localInferenceMode: true }),
    credential: null,
    request: REQUEST,
  });

  assert.equal(outcome.status, "ok");
});

test("the Authorization header carries the credential when present, and is absent when not", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedHeaders = init.headers as Record<string, string>;
    return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ title: "T", description: "D" }) } }] });
  };
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  await adapter.generate({ connection: makeConnection(), credential: "sk-secret", request: REQUEST });
  assert.equal(capturedHeaders?.Authorization, "Bearer sk-secret");

  await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });
  assert.equal(capturedHeaders?.Authorization, undefined);
});

test("the outbound request never follows redirects (SSRF: a validated public endpoint must not be able to redirect to an internal address)", async () => {
  let capturedRedirectMode: string | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedRedirectMode = init.redirect as string | undefined;
    // Simulate what a real fetch does with redirect: "manual" -- the 3xx status
    // comes back as an ordinary (non-ok) response instead of being followed.
    return { ok: false, status: 302, json: async () => ({}), text: async () => "" };
  };
  const adapter = createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: PUBLIC_DNS_LOOKUP });

  const { outcome } = await adapter.generate({ connection: makeConnection(), credential: null, request: REQUEST });

  assert.equal(capturedRedirectMode, "manual");
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { message: string }).message, "HTTP 302");
});
