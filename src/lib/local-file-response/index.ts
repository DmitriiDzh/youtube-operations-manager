import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

// The one way a route sends a local media file to the browser with HTTP Range (so a player can seek without loading the whole file).
// Shared by the plan review's audition route (BL-143) and the storyboard takes (BL-184); the caller has already proven the file is the
// one it may send (workspace-exchange) and chosen its type.

/**
 * One `bytes=` range (RFC 9110 §14.1.2): `a-b`, `a-` or `-n`. `null` = serve the whole file (no Range header, or a multi-range
 * request, which RFC 9110 lets a server ignore); `"invalid"` = not satisfiable.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  if (header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "") || size === 0) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/** The file itself, with HTTP Range; never cached (a file may be replaced). */
export function streamLocalFile(file: { path: string; bytes: number }, type: string, request: Request): Response {
  const range = parseRange(request.headers.get("range"), file.bytes);
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.bytes}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, file.bytes - 1);
  const length = file.bytes === 0 ? 0 : end - start + 1;
  const body = length === 0 ? null : (Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { ...headers, "content-length": String(length), ...(range ? { "content-range": `bytes ${start}-${end}/${file.bytes}` } : {}) },
  });
}
