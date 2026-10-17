import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import type { VideoCostsBackfill, VideoCostsService } from "@/lib/video-costs";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-194 stage 3 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): the visual cost of the channel's videos -- one total
// per video (and «не привязано»), and one video's runs on every computer. Read-only. A Web session and the ACTIVE channel are required
// (AGENTS.md §F, ADR 0004); the module itself refuses a channel not connected here. The Operator reads the same through
// factory_video_get_cost.

export type VideoCostsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => Promise<Pick<VideoCostsService, "summary" | "videoCost">>;
  /** BL-194 stage 4: older runs (proposals, the owner's confirmation, linking runs of an already linked storyboard or plan). */
  backfill: () => Promise<VideoCostsBackfill>;
};

const defaultDeps = (): VideoCostsRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  // Loaded on use: the cost module never takes another route down with it (AGENTS.md §M).
  service: async () => (await import("@/lib/video-costs")).createVideoCostsServiceForProduction(),
  // The storyboard's video is set through the storyboards module's own owner action (it syncs the link); the cost module only links
  // this computer's runs afterwards.
  backfill: async () => {
    const [{ createVideoCostsBackfillForProduction }, { createStoryboardsServiceForProduction }] = await Promise.all([import("@/lib/video-costs"), import("@/lib/storyboards")]);
    return createVideoCostsBackfillForProduction({
      setStoryboardVideo: async (channelId, storyboardId, video) => {
        await createStoryboardsServiceForProduction().ownerSetVideo(channelId, storyboardId, { videoNumber: video });
      },
    });
  },
});

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = () => NextResponse.json({ error: "validation_failed", message: "The request must be a JSON object without channelId (the channel is the one in the address)." }, { status: 400 });

function errorResponse(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

export function createVideoCostsRouteHandlers(deps: VideoCostsRouteDeps = defaultDeps()) {
  async function guarded<T extends Base>(context: Params<T>, run: (params: T) => Promise<Response>): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const params = await context.params;
      await deps.assertActiveChannel({ userId, channelId: params.channelId });
      return await run(params);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return {
    summary: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await (await deps.service()).summary({ channelId }))),
    video: (_request: Request, context: Params<Base & { video: string }>) =>
      guarded(context, async ({ channelId, video }) => NextResponse.json(await (await deps.service()).videoCost({ channelId, video: decodeURIComponent(video) }))),

    /** Stage 4: GET -- storyboards whose render is a video file of a `MMDD Vn` folder, and runs here not linked yet. Changes nothing. */
    backfillProposals: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await (await deps.backfill()).proposals({ channelId }))),

    /** Stage 4: POST `{ video }` -- the owner confirms a proposal (or picks the video by hand) for a storyboard of the channel. */
    confirmStoryboard: (request: Request, context: Params<Base & { storyboardId: string }>) =>
      guarded(context, async ({ channelId, storyboardId }) => {
        const body = await bodyOf(request);
        if (!body || "channelId" in body || "storyboardId" in body) return badBody();
        return NextResponse.json(await (await deps.backfill()).confirmStoryboard({ ...body, channelId, storyboardId: decodeURIComponent(storyboardId) }));
      }),

    /** Stage 4: POST `{ kind: storyboard | plan, id }` -- links this computer's runs of it to the video it already has. */
    linkRuns: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => {
        const body = await bodyOf(request);
        if (!body || "channelId" in body) return badBody();
        return NextResponse.json(await (await deps.backfill()).linkRuns({ ...body, channelId }));
      }),
  };
}
