import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createImageReviewsOwnerCore, type ImageReviewsOwnerSurface } from "@/lib/image-reviews";
import { streamLocalFile } from "@/lib/local-file-response";
import { isOwnerBrowserRequest } from "@/lib/loopback-guard";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-272 (ADR 0076): the owner's side of the master still images for review -- the list with the count waiting for him, the image
// and its large preview from this computer's copy, and his decision (approve, approve with a note, return). A Web session and the
// ACTIVE channel are required (AGENTS.md §F); every rule of the decision is the image-reviews module's. The files go to the owner's
// browser on this computer or, through the proxy's remote gate, on his phone (as the clips, BL-251 amendment 2). No MCP path reaches
// these handlers (image-reviews/boundaries.test.ts).

export type ImageReviewRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => ImageReviewsOwnerSurface;
  /** The owner's own browser: this computer, or a remote request that passed the proxy's remote gate (never a foreign page). */
  isOwnerBrowser: (request: Request) => boolean;
};

const defaultDeps = (): ImageReviewRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  service: createImageReviewsOwnerCore,
  isOwnerBrowser: (request) => isOwnerBrowserRequest(request.headers),
});

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };
const forbidden = () => NextResponse.json({ error: "forbidden", message: "Local files are served to the owner's browser only" }, { status: 403 });
const missing = () => NextResponse.json({ error: "image_review_file_missing", message: "This image's file is not on this computer" }, { status: 404 });

export function createImageReviewRouteHandlers(deps: ImageReviewRouteDeps = defaultDeps()) {
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
    /** The channel's images (pending first, each with this computer's copy: ok | missing | changed) and how many wait (the badge). */
    list: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().ownerList(channelId))),

    /** POST `{ action: approve | approve_with_note | return, comment? }` (a note-approval and a return need a comment). */
    decide: (request: Request, context: Params<Base & { imageId: string }>) =>
      guarded(context, async ({ channelId, imageId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().decide(channelId, imageId, input, userId));
      }),

    /** The image at full size from this computer's copy; never its path. */
    image: (request: Request, context: Params<Base & { imageId: string }>) =>
      guarded(context, async ({ channelId, imageId }) => {
        if (!deps.isOwnerBrowser(request)) return forbidden();
        const file = await deps.service().imageFile(channelId, imageId);
        if (!file) return missing();
        const response = streamLocalFile(file, file.type, request);
        response.headers.set("cache-control", "private, no-cache");
        return response;
      }),

    /** A large JPEG thumbnail for the grid (the original when none can be made here). */
    preview: (request: Request, context: Params<Base & { imageId: string }>) =>
      guarded(context, async ({ channelId, imageId }) => {
        if (!deps.isOwnerBrowser(request)) return forbidden();
        const preview = await deps.service().previewFile(channelId, imageId);
        if (!preview) return missing();
        if ("file" in preview) return streamLocalFile(preview.file, preview.type, request);
        return new Response(preview.body as BodyInit, { status: 200, headers: { "content-type": preview.type, "content-length": String(preview.body.byteLength), "cache-control": "private, no-cache" } });
      }),
  };
}
