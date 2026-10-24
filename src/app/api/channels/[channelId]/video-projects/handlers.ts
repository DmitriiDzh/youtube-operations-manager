import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createVideoProjectsServiceForProduction, type VideoProjectsService } from "@/lib/video-projects";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-194 stage 1 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2, ADR 0040): the channel's videos by number -- the list (with the
// conflicts of two computers), «Новый ролик», the losing computer's «Взять следующий номер», and giving a video up. A Web session
// and the ACTIVE channel are required (AGENTS.md §F, ADR 0004); every rule is the video-projects module's. Scripts reach the same
// actions through these routes; the Operator through factory_video_create / factory_video_list.

export type VideoProjectsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => Pick<VideoProjectsService, "listVideos" | "createVideo" | "renumber" | "cancelVideo" | "linkSuggestions" | "linkVideo">;
};

const defaultDeps = (): VideoProjectsRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  service: createVideoProjectsServiceForProduction,
});

function errorResponse(error: unknown) {
  // `isDomainError`, never `instanceof`: the module lives on globalThis and may have been built by another bundle (FO-REQ-0005).
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createVideoProjectsRouteHandlers(deps: VideoProjectsRouteDeps = defaultDeps()) {
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
    /** `?state=in_work|packaged|published|cancelled`: the channel's videos, highest number first, and the next free number. */
    list: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => {
        const state = new URL(request.url).searchParams.get("state") ?? undefined;
        return NextResponse.json(await deps.service().listVideos({ channelId, ...(state ? { state } : {}) }));
      }),

    /** «Новый ролик»: `{ workingTitle? }` -> the next free number of the channel, reserved on this computer. */
    create: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => {
        const body = await bodyOf(request);
        if (!body) return NextResponse.json({ error: "validation_failed", message: "The request must be a JSON object." }, { status: 400 });
        if ("channelId" in body) return NextResponse.json({ error: "validation_failed", message: "The channel is the one in the address; do not send channelId." }, { status: 400 });
        return NextResponse.json(await deps.service().createVideo({ ...body, channelId }), { status: 201 });
      }),

    /** The losing computer of a duplicate takes the next free number (only on the owner's choice). */
    renumber: (_request: Request, context: Params<Base & { video: string }>) =>
      guarded(context, async ({ channelId, video }) => NextResponse.json(await deps.service().renumber({ channelId, video: decodeURIComponent(video) }))),

    /** Gives up a video reserved on this computer. */
    cancel: (_request: Request, context: Params<Base & { video: string }>) =>
      guarded(context, async ({ channelId, video }) => NextResponse.json(await deps.service().cancelVideo({ channelId, video: decodeURIComponent(video) }))),

    /** BL-221 «Привязать к видео»: the synced videos offered for a number (by its folder's date, never by title). */
    linkSuggestions: (_request: Request, context: Params<Base & { video: string }>) =>
      guarded(context, async ({ channelId, video }) => NextResponse.json(await deps.service().linkSuggestions({ channelId, video: decodeURIComponent(video) }))),

    /** BL-221 «Привязать к видео»: `{ videoId }` -- the owner's confirmed link, written as the folder's `Vn_youtube.json`. */
    link: (request: Request, context: Params<Base & { video: string }>) =>
      guarded(context, async ({ channelId, video }) => {
        const body = await bodyOf(request);
        if (!body) return NextResponse.json({ error: "validation_failed", message: "The request must be a JSON object." }, { status: 400 });
        if ("channelId" in body || "video" in body) {
          return NextResponse.json({ error: "validation_failed", message: "The channel and the number are the ones in the address; send only videoId." }, { status: 400 });
        }
        return NextResponse.json(await deps.service().linkVideo({ ...body, channelId, video: decodeURIComponent(video) }));
      }),
  };
}
