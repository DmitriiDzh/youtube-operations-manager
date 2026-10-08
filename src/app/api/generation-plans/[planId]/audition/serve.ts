import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/loopback-guard";
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

/**
 * One `bytes=` range (RFC 9110 §14.1.2): `a-b`, `a-` or `-n`. `null` = serve the whole file (no Range header, or a
 * multi-range request, which RFC 9110 lets a server ignore); `"invalid"` = not satisfiable.
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

export type AuditionDeps = {
  getSession(): Promise<{ user?: { id?: string | null } } | null>;
  /** BL-157 (AC-SM-03): refuses (plan_not_found) a plan that is not the session's active channel's. */
  assertVisible(userId: string, planId: string): Promise<void>;
  resolveAudition(input: { planId: string; itemKey: string; attemptRef: string }): Promise<{ channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string })>;
  /** The channel's workspace folder on this device, or null. */
  workspaceOf(channelId: string): Promise<string | null>;
  /** `workspace-exchange` resolvers, wired in the route. */
  resolveSentFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number }>;
  resolveJobFile(workspace: string, jobId: string, filePath: string): Promise<{ path: string; bytes: number }>;
};

type ResolvedTarget = { channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string });

/** The audition of one attempt: `?itemKey=&attemptRef=` (nothing else). */
export function createAuditionGetHandler(deps: AuditionDeps) {
  return createPlanFileGetHandler(deps, ["itemKey", "attemptRef"], (planId, q) => deps.resolveAudition({ planId, itemKey: q.itemKey, attemptRef: q.attemptRef }));
}

/** BL-143 phase 3 (FO-MSG-0009): a plan reference for A/B, `?id=` -- the same checks, Range and types as an audition. */
export function createReferenceGetHandler(deps: Omit<AuditionDeps, "resolveAudition"> & { resolveReference(input: { planId: string; id: string }): Promise<ResolvedTarget> }) {
  return createPlanFileGetHandler(deps, ["id"], (planId, q) => deps.resolveReference({ planId, id: q.id }));
}

function createPlanFileGetHandler(deps: Omit<AuditionDeps, "resolveAudition">, names: string[], resolveTarget: (planId: string, query: Record<string, string>) => Promise<ResolvedTarget>) {
  return async function GET(request: Request, context: { params: Promise<{ planId: string }> }): Promise<Response> {
    // A local file leaves this route only for a browser on this computer (ADR 0029 §5): loopback Host and Origin.
    if (!isLoopbackRequest(request.headers)) return NextResponse.json({ error: "forbidden", message: "Local files are served only to this computer" }, { status: 403 });
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      await deps.assertVisible(userId, planId);
      const url = new URL(request.url);
      const extra = [...url.searchParams.keys()].filter((k) => !names.includes(k));
      if (extra.length > 0) return NextResponse.json({ error: "validation_failed", message: `Unknown query parameter ${extra[0]}: only ${names.join(" and ")}` }, { status: 400 });
      const query: Record<string, string> = {};
      for (const name of names) {
        const value = url.searchParams.get(name);
        if (!value) return NextResponse.json({ error: "validation_failed", message: `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} required` }, { status: 400 });
        query[name] = value;
      }
      const target = await resolveTarget(planId, query);
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
