import type { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// Phase 14 (review round 15, AGENTS.md §M): the ONE transport step every gateway child shares --
// fetch with a timeout, read the body (the timeout can fire mid-stream too), parse JSON or keep the
// raw text. Status mapping stays with each child (RunPod's 401/403 = bad key; ComfyUI's JSON 4xx =
// its own verdict), so a transport fix lands once instead of in two near-verbatim copies.
// ---------------------------------------------------------------------------

export type JsonResponse = { status: number; ok: boolean; body: unknown };

export async function jsonRequest(args: {
  fetchImpl: typeof fetch;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** The error for a transport failure: the request itself (no response) or reading its body. */
  unavailable: (stage: "request" | "read", detail: string, status?: number) => DomainError;
}): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.url, { method: args.method, headers: args.headers, body: args.body, signal: AbortSignal.timeout(args.timeoutMs) });
  } catch (error) {
    throw args.unavailable("request", error instanceof Error ? error.message : String(error));
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw args.unavailable("read", error instanceof Error ? error.message : String(error), response.status);
  }
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  return { status: response.status, ok: response.ok, body };
}

/** True for a parsed JSON body (an object), false for `{ raw }` (non-JSON text) or no body. */
export function isJsonBody(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !("raw" in (body as Record<string, unknown>));
}
