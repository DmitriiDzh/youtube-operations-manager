import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createClipReviewsOwnerCore, type ClipReviewsOwnerSurface } from "@/lib/clip-reviews";
import { streamLocalFile } from "@/lib/local-file-response";
import { isLoopbackRequest } from "@/lib/loopback-guard";
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
  isLoopback: (request) => isLoopbackRequest(request.headers),
});

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
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
  };
}
