import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
  /** BL-174: `"error"` for a child whose credential header must never follow a redirect (fetch keeps custom headers across hosts). */
  redirect?: RequestRedirect;
  /**
   * The error for a transport failure: the request itself (no response) or reading its body. BL-174: `cause` is the caught
   * error, so a child can tell "never reached the server" from "sent, then timed out" (the Gemini child counts the second
   * as a possibly-charged call).
   */
  unavailable: (stage: "request" | "read", detail: string, status?: number, cause?: unknown) => DomainError;
}): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: AbortSignal.timeout(args.timeoutMs),
      ...(args.redirect ? { redirect: args.redirect } : {}),
    });
  } catch (error) {
    throw args.unavailable("request", error instanceof Error ? error.message : String(error), undefined, error);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw args.unavailable("read", error instanceof Error ? error.message : String(error), response.status, error);
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

/**
 * BL-179 (independent review, blocker): a fetch-shaped call over `node:http(s)` for a request that may wait longer than fetch's
 * own limits -- undici gives up after 300 s without response headers (`UND_ERR_HEADERS_TIMEOUT`) or 300 s between body chunks,
 * whatever the AbortSignal says. An Omni video is generated within its one call, so the answer can take longer than that.
 *
 * The same contract as fetch for `jsonRequest`: it rejects on a transport error (keeping its `code`, so "never sent" can still
 * be told from "sent, then lost") or when the signal fires (its reason: a `TimeoutError` stays a timeout). It never follows a
 * redirect -- a 3xx comes back as an answer -- so a credential header never travels to another host. The body is read whole,
 * up to `maxBodyBytes`.
 */
export function createLongWaitFetch(options: { maxBodyBytes: number }): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
      if (!send) {
        reject(Object.assign(new TypeError(`Unsupported protocol ${url.protocol}`), { code: "ERR_INVALID_URL" }));
        return;
      }
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body = typeof init.body === "string" ? Buffer.from(init.body) : undefined;
      if (init.body !== undefined && init.body !== null && body === undefined) {
        reject(new TypeError("Only a string body is supported here"));
        return;
      }
      if (body) headers["content-length"] = String(body.length);
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        outcome();
      };
      const req = send(url, { method: init.method ?? "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > options.maxBodyBytes) {
            // Refused here, then the connection is closed without an error event (nothing left to listen for it).
            finish(() => reject(Object.assign(new Error(`The answer passed ${options.maxBodyBytes} bytes`), { code: "ERR_BODY_TOO_LARGE" })));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = res.statusCode ?? 502;
          const noBody = status === 204 || status === 304;
          // A status fetch cannot represent (outside 200-599) is a transport failure, never an uncaught throw (review re-check).
          finish(() => {
            try {
              resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
            } catch (error) {
              reject(Object.assign(new Error(`Unusable answer (HTTP ${status}): ${error instanceof Error ? error.message : String(error)}`), { code: "ERR_INVALID_RESPONSE" }));
            }
          });
        });
        res.on("error", (error) => finish(() => reject(error)));
        res.on("aborted", () => finish(() => reject(Object.assign(new Error("The answer was cut off"), { code: "ECONNRESET" }))));
      });
      const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (error) => finish(() => reject(error)));
      if (body) req.write(body);
      req.end();
    })) as typeof fetch;
}
