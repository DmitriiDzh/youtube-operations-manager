import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { CLIP_ATTACHMENT_LIMITS, createClipReviewsOwnerCore, type ClipReviewsOwnerSurface } from "@/lib/clip-reviews";
import { streamLocalFile } from "@/lib/local-file-response";
import { isOwnerBrowserRequest } from "@/lib/loopback-guard";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-241 (CLIP_REVIEWS_PLAN.md items 5-6, ADR 0061 §4, §6): the owner's side of the clips for review -- the list with the count
// waiting for him, the clip's video from this computer's copy (HTTP Range), and his decision (approve or return). A Web session and
// the ACTIVE channel are required (AGENTS.md §F); every rule of the decision is the clip-reviews module's. No MCP path reaches these
// handlers (AC-CR-12 source scan).

export type ClipReviewRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => ClipReviewsOwnerSurface;
  /** ADR 0029 decision 5: a local file is sent only to a request from this computer (a second layer behind the 127.0.0.1 bind). */
  isLoopback: (request: Request) => boolean;
};

const defaultDeps = (): ClipReviewRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  service: createClipReviewsOwnerCore,
  isLoopback: (request) => isOwnerBrowserRequest(request.headers), // BL-251 amendment 2: the phone plays them too
});

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-246: one piece of an attachment, read as it arrives and refused past `limit` without holding more. A body shorter than its
 * declared `content-length` (cut on the way) is refused too: a piece is all or nothing.
 */
async function readPiece(request: Request, limit: number): Promise<Uint8Array | "too_large" | "incomplete"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return "too_large";
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  if (declared !== null && Number(declared) !== total) return "incomplete";
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** RFC 5987 `ext-value`: `encodeURIComponent` leaves `' ( ) *` as they are, but they are not attr-chars (review). */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

export function createClipReviewRouteHandlers(deps: ClipReviewRouteDeps = defaultDeps()) {
  /** The session's user on the active channel, or the answer to send instead. */
  async function guarded<T extends Base>(context: Params<T>, run: (params: T, userId: string) => Promise<Response>): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const params = await context.params;
      await deps.assertActiveChannel({ userId, channelId: params.channelId });
      return await run(params, userId);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    /** The channel's clips (pending first, each with this computer's copy: ok | missing | changed) and how many wait (the badge). */
    list: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().ownerList(channelId))),

    /** POST `{ action: approve | return, comment? }` (a return needs a comment). */
    decide: (request: Request, context: Params<Base & { clipId: string }>) =>
      guarded(context, async ({ channelId, clipId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().decide(channelId, clipId, input, userId));
      }),

    /** The clip's video from this computer's copy, with HTTP Range (the player seeks in a 100 MB file); never its path. */
    video: (request: Request, context: Params<Base & { clipId: string }>) =>
      guarded(context, async ({ channelId, clipId }) => {
        if (!deps.isLoopback(request)) return NextResponse.json({ error: "forbidden", message: "Local files are served to this computer only" }, { status: 403 });
        const file = await deps.service().clipFile(channelId, clipId);
        if (!file) return NextResponse.json({ error: "clip_review_file_missing", message: "This clip's file is not on this computer" }, { status: 404 });
        return streamLocalFile(file, file.type, request);
      }),

    // ---- BL-246 (ADR 0065, CLIP_REVIEWS_PLAN.md items 13 and 16): the owner's comment attachments ----

    /** POST `{ name, type, size, sha256 }`: stage one file for the next decision on this clip -> `{ uploadId, name, mime }`. */
    stageAttachment: (request: Request, context: Params<Base & { clipId: string }>) =>
      guarded(context, async ({ channelId, clipId }) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().stageAttachment(channelId, clipId, input));
      }),

    /** PUT `?offset=<bytes received so far>` with the next piece (at most 4 MiB) as the body -> `{ received, complete }`. */
    attachmentPiece: (request: Request, context: Params<Base & { clipId: string; uploadId: string }>) =>
      guarded(context, async ({ channelId, clipId, uploadId }) => {
        const offsetText = new URL(request.url).searchParams.get("offset") ?? "";
        if (!/^\d{1,12}$/.test(offsetText)) throw new DomainError({ code: "validation_failed", message: "offset must be the number of bytes already sent", details: { offset: offsetText } });
        const piece = await readPiece(request, CLIP_ATTACHMENT_LIMITS.pieceBytes);
        if (piece === "too_large") throw new DomainError({ code: "validation_failed", message: `A piece is at most ${CLIP_ATTACHMENT_LIMITS.pieceBytes} bytes`, details: {} });
        if (piece === "incomplete") throw new DomainError({ code: "validation_failed", message: "The piece arrived incomplete; send it again", details: {} });
        return NextResponse.json(await deps.service().appendAttachmentPiece(channelId, clipId, uploadId, Number(offsetText), piece));
      }),

    /** DELETE: the owner removed the chip -- its staged file is dropped. */
    discardAttachment: (_request: Request, context: Params<Base & { clipId: string; uploadId: string }>) =>
      guarded(context, async ({ channelId, clipId, uploadId }) => NextResponse.json(await deps.service().discardAttachment(channelId, clipId, uploadId))),

    /**
     * GET one attachment of a decision from this computer's copy, to a loopback request only (ADR 0029 decision 5): never its path;
     * a file not here yet is 404 `clip_attachment_missing`, a different one 409 `clip_attachment_changed`.
     */
    attachment: (request: Request, context: Params<Base & { clipId: string; decisionId: string; index: string }>) =>
      guarded(context, async ({ channelId, clipId, decisionId, index }) => {
        if (!deps.isLoopback(request)) return NextResponse.json({ error: "forbidden", message: "Local files are served to this computer only" }, { status: 403 });
        if (!/^\d{1,2}$/.test(index)) return NextResponse.json({ error: "clip_attachment_not_found", message: "No such attachment" }, { status: 404 });
        const file = await deps.service().attachmentFile(channelId, clipId, decisionId, Number(index));
        const response = streamLocalFile(file, file.type, request);
        response.headers.set("content-disposition", `inline; filename*=UTF-8''${rfc5987(file.name)}`);
        return response;
      }),
  };
}
