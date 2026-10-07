import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { planErrorResponse } from "../../shared";

// BL-143 (ADR 0029 decision 5, AC-GP-14): the one route that sends a local media file to the browser -- the file of ONE
// attempt of ONE plan, found by the plans core (never a path from the request), proven inside the channel workspace by
// `workspace-exchange` (symlinks resolved), of an allowlisted type, with HTTP Range so the player can seek.

/** The types the review screen plays or shows; anything else is refused (415). */
export const AUDITION_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

export function contentTypeFor(filePath: string): string | null {
  return AUDITION_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** One `bytes=` range (RFC 9110 §14.1.2): `a-b`, `a-` or `-n`. `null` = no Range header; `"invalid"` = not satisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
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

export type AuditionDeps = {
  getSession(): Promise<{ user?: { id?: string | null } } | null>;
  resolveAudition(input: { planId: string; itemKey: string; attemptRef: string }): Promise<{ channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string })>;
  /** The channel's workspace folder on this device, or null. */
  workspaceOf(channelId: string): Promise<string | null>;
  /** `workspace-exchange` resolvers, wired in the route. */
  resolveSentFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number }>;
  resolveJobFile(workspace: string, jobId: string, filePath: string): Promise<{ path: string; bytes: number }>;
};

export function createAuditionGetHandler(deps: AuditionDeps) {
  return async function GET(request: Request, context: { params: Promise<{ planId: string }> }): Promise<Response> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      const url = new URL(request.url);
      const extra = [...url.searchParams.keys()].filter((k) => k !== "itemKey" && k !== "attemptRef");
      if (extra.length > 0) return NextResponse.json({ error: "validation_failed", message: `Unknown query parameter ${extra[0]}: only itemKey and attemptRef` }, { status: 400 });
      const itemKey = url.searchParams.get("itemKey");
      const attemptRef = url.searchParams.get("attemptRef");
      if (!itemKey || !attemptRef) return NextResponse.json({ error: "validation_failed", message: "itemKey and attemptRef are required" }, { status: 400 });
      const target = await deps.resolveAudition({ planId, itemKey, attemptRef });
      const workspace = await deps.workspaceOf(target.channelId);
      if (!workspace) return NextResponse.json({ error: "not_found", message: "This channel has no workspace folder on this device, so the file cannot be played here." }, { status: 404 });
      let file: { path: string; bytes: number };
      try {
        file = target.kind === "sent" ? await deps.resolveSentFile(workspace, target.relativePath) : await deps.resolveJobFile(workspace, target.jobId, target.localPath);
      } catch (error) {
        return NextResponse.json({ error: "not_found", message: `The file is not available on this device: ${error instanceof Error ? error.message : String(error)}` }, { status: 404 });
      }
      const type = contentTypeFor(file.path);
      if (!type) return NextResponse.json({ error: "unsupported_media_type", message: `${path.extname(file.path) || "This file type"} is not played here` }, { status: 415 });
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
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}
