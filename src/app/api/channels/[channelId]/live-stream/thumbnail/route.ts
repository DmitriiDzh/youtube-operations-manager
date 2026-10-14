import { NextResponse } from "next/server";
import { THUMBNAIL_MAX_BYTES } from "@/lib/youtube-video-fields";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §3.1): the stream's thumbnail, kept on this computer. PUT takes the image's bytes as the
// body (a JPEG or PNG by its first bytes, at most 2 MB, checked again by the module); GET serves it for the preview; DELETE
// removes it. Local only: nothing here writes to YouTube.

const CONTENT_TYPES = { jpeg: "image/jpeg", png: "image/png" } as const;

/** Reads at most `limit` + 1 bytes, so an oversized body is refused without holding it all. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
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
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createLiveStreamThumbnailHandlers(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return {
    GET: liveStreamHandler(deps, async ({ core, channelId }) => {
      const image = await core.readThumbnail(channelId);
      if (!image) return NextResponse.json({ error: "not_found", message: "The stream has no thumbnail" }, { status: 404 });
      return new NextResponse(Buffer.from(image.bytes), { headers: { "content-type": CONTENT_TYPES[image.kind], "cache-control": "private, no-cache" } });
    }),
    PUT: liveStreamHandler(deps, async ({ core, channelId, request }) => {
      const bytes = await readCapped(request, THUMBNAIL_MAX_BYTES);
      if (!bytes) {
        return NextResponse.json({ error: "validation_failed", message: "The image is over YouTube's 2 MB thumbnail limit" }, { status: 413 });
      }
      return NextResponse.json(await core.setThumbnail(channelId, bytes));
    }),
    DELETE: liveStreamHandler(deps, async ({ core, channelId }) => {
      await core.clearThumbnail(channelId);
      return NextResponse.json({ removed: true });
    }),
  };
}

const handlers = createLiveStreamThumbnailHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
