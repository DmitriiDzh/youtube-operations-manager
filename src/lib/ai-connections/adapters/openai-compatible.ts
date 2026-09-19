import { DomainError, type AiConnection, type ConnectionProtocolAdapter, type LocalizationGenerationRequest } from "../contracts";
import { validateEndpointUrl, type DnsLookupFn } from "../endpoint-security";

// ---------------------------------------------------------------------------
// The one real (non-mock) protocol adapter in this MVP: the OpenAI Chat Completions
// request/response shape, which OpenAI itself and a number of other vendors and
// local-inference servers (LM Studio, vLLM, Ollama's OpenAI-compat layer, etc.) also
// implement. This adapter does NOT claim to work with an arbitrary, unknown API --
// it only claims this one specific, documented shape, and refuses (capability_not_
// supported) rather than guessing when a connection's declared `structuredOutput`
// capability is "none" (AC-CONN-10).
//
// `fetchImpl` is always injected, never a bare global `fetch` call inside this file --
// this is what makes AC-CONN-14 ("zero real network calls in the automated test
// suite") a structurally-checkable property rather than a promise: a test can only
// reach a real host if it deliberately wires a real fetch implementation in, which no
// test in this repository does.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 750];

export type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function buildInstructionPrompt(request: LocalizationGenerationRequest): string {
  const lines = [
    `Translate/localize the following YouTube video metadata into the language "${request.targetLanguage}".`,
    request.sourceLanguage ? `The source language is "${request.sourceLanguage}".` : "",
    "Respond with a JSON object with exactly two string fields: \"title\" and \"description\". Do not include any other text.",
  ];

  const brief = request.editorialBrief;
  if (brief) {
    if (brief.targetAudience) lines.push(`Target audience: ${brief.targetAudience}`);
    if (brief.toneNotes) lines.push(`Tone and style: ${brief.toneNotes}`);
    if (brief.terminologyNotes) lines.push(`Preferred terminology: ${brief.terminologyNotes}`);
    if (brief.titleConstraints) lines.push(`Title constraints: ${brief.titleConstraints}`);
    if (brief.descriptionConstraints) lines.push(`Description constraints: ${brief.descriptionConstraints}`);
  }

  return lines.filter(Boolean).join("\n");
}

function buildResponseFormat(capability: AiConnection["capabilities"]["structuredOutput"]) {
  if (capability === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: "localization_proposal",
        strict: true,
        schema: {
          type: "object",
          properties: { title: { type: "string" }, description: { type: "string" } },
          required: ["title", "description"],
          additionalProperties: false,
        },
      },
    };
  }
  if (capability === "json_object") {
    return { type: "json_object" };
  }
  return null;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenAiCompatibleAdapter(deps: {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  dnsLookup?: DnsLookupFn;
}): ConnectionProtocolAdapter {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function callOnce(connection: AiConnection, credential: string | null, body: unknown) {
    if (!connection.baseUrl) {
      throw new DomainError({ code: "endpoint_not_allowed", message: "This connection has no Base URL configured" });
    }
    await validateEndpointUrl(connection.baseUrl, { allowLocal: connection.localInferenceMode, dnsLookup: deps.dnsLookup });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (credential) headers.Authorization = `Bearer ${credential}`;

      const response = await deps.fetchImpl(`${connection.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // `validateEndpointUrl` only validates the URL we are about to request --
        // it says nothing about wherever a 3xx response might point next. With the
        // default "follow", a validated-public, HTTPS endpoint could redirect the
        // real request to an internal/loopback/metadata address (e.g.
        // `169.254.169.254`) and completely bypass the SSRF check above. "manual"
        // makes a redirect surface as an ordinary non-2xx response (handled by the
        // existing HTTP-status error path below) instead of being followed.
        redirect: "manual",
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    adapterType: "openai_compatible",

    async generate({ connection, credential, request }) {
      const responseFormat = buildResponseFormat(connection.capabilities.structuredOutput);
      if (!responseFormat) {
        throw new DomainError({
          code: "capability_not_supported",
          message: `Connection "${connection.displayName}" does not declare a supported structured-output capability (got "${connection.capabilities.structuredOutput}")`,
        });
      }

      const requestBody = {
        model: connection.modelId,
        messages: [
          { role: "system", content: buildInstructionPrompt(request) },
          { role: "user", content: `Title: ${request.sourceTitle}\nDescription: ${request.sourceDescription}` },
        ],
        response_format: responseFormat,
      };

      let response;
      let attempt = 0;
      for (;;) {
        try {
          response = await callOnce(connection, credential, requestBody);
        } catch (error) {
          if (error instanceof DomainError) throw error;
          if (error instanceof Error && error.name === "AbortError") {
            return { outcome: { status: "error", message: "timeout" }, usage: null };
          }
          return { outcome: { status: "error", message: error instanceof Error ? error.message : "network error" }, usage: null };
        }

        if (response.ok || !isTransientHttpStatus(response.status) || attempt >= MAX_RETRIES) {
          break;
        }
        await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
        attempt += 1;
      }

      if (!response.ok) {
        return { outcome: { status: "error", message: `HTTP ${response.status}` }, usage: null };
      }

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        return { outcome: { status: "error", message: "Response was not valid JSON" }, usage: null };
      }

      const content = extractMessageContent(parsedBody);
      if (content === null) {
        return { outcome: { status: "error", message: "Response did not contain an expected chat completion message" }, usage: null };
      }

      let proposal: unknown;
      try {
        proposal = JSON.parse(content);
      } catch {
        return { outcome: { status: "error", message: "Model output was not valid JSON" }, usage: null };
      }

      if (
        typeof proposal !== "object" ||
        proposal === null ||
        typeof (proposal as Record<string, unknown>).title !== "string" ||
        typeof (proposal as Record<string, unknown>).description !== "string"
      ) {
        return { outcome: { status: "error", message: "Model output was missing the required title/description fields" }, usage: null };
      }

      const usage = extractUsage(parsedBody);

      return {
        outcome: { status: "ok", title: (proposal as { title: string }).title, description: (proposal as { description: string }).description },
        usage,
      };
    },

    async testConnection({ connection, credential }) {
      try {
        const result = await this.generate({
          connection,
          credential,
          request: {
            videoId: "connection-test",
            targetLanguage: "en",
            sourceLanguage: "en",
            sourceTitle: "Connection test",
            sourceDescription: "This is a connection test request.",
          },
        });
        if (result.outcome.status === "error") {
          return { ok: false, message: result.outcome.message, mayIncurCost: true };
        }
        return { ok: true, message: "Connection responded successfully.", mayIncurCost: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Unknown error", mayIncurCost: true };
      }
    },
  };
}

function extractMessageContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function extractUsage(body: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const promptTokens = (usage as Record<string, unknown>).prompt_tokens;
  const completionTokens = (usage as Record<string, unknown>).completion_tokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  return { inputTokens: promptTokens, outputTokens: completionTokens };
}
