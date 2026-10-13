import { readFile } from "node:fs/promises";
import path from "node:path";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { DomainError } from "@/lib/shared-domain";
import { createStoryboardsServiceForProduction, type StoryboardsService } from "@/lib/storyboards";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-184 stage 1 (FO-REQ-0024 §4 B2; STORYBOARD_PLAN.md §3 stage 1 item 3): the owner's side of a storyboard -- the list, one
// storyboard with this computer's copy of its keyframes and what changed against the version before, comments (with pins), replies,
// open / resolved, «Запросить изменения» / «Одобрить эту версию», and the keyframe images. A Web session and the ACTIVE channel are
// required (AGENTS.md §F); every rule of the actions themselves is the storyboards module's.

export type StoryboardRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => Pick<
    StoryboardsService,
    "listForOwner" | "getForOwner" | "keyframeFiles" | "versionDiff" | "keyframeFile" | "ownerComment" | "ownerReply" | "ownerSetCommentState" | "ownerDecide" | "gateSetting" | "setGateSetting"
  >;
  readFile: (filePath: string) => Promise<Uint8Array>;
};

const defaultDeps = (): StoryboardRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  service: createStoryboardsServiceForProduction,
  readFile: (filePath) => readFile(filePath),
});

/** The image types a keyframe may be (the viewer shows them as they are). */
const IMAGE_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

export function createStoryboardRouteHandlers(deps: StoryboardRouteDeps = defaultDeps()) {
  /** The session's user on the active channel, or the answer to send instead. */
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
  const body = (request: Request) => request.json().catch(() => null);

  return {
    list: (_request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => NextResponse.json({ storyboards: await deps.service().listForOwner(channelId) })),

    /** `?version=N` (default: the latest): the storyboard, this computer's copy of that version's keyframes, and its diff. */
    detail: (request: Request, context: Params<Base & { storyboardId: string }>) =>
      guarded(context, async ({ channelId, storyboardId }) => {
        const service = deps.service();
        const storyboard = await service.getForOwner(channelId, storyboardId);
        const asked = new URL(request.url).searchParams.get("version");
        const version = asked === null ? storyboard.latestVersion : Number(asked);
        if (!Number.isInteger(version) || version < 1) return NextResponse.json({ error: "validation_failed", message: "version must be a whole number" }, { status: 400 });
        const [files, diff] = await Promise.all([service.keyframeFiles(channelId, storyboardId, version), service.versionDiff(channelId, storyboardId, version)]);
        return NextResponse.json({ storyboard, version, files, diff });
      }),

    comment: (request: Request, context: Params<Base & { storyboardId: string }>) =>
      guarded(context, async ({ channelId, storyboardId }) => NextResponse.json(await deps.service().ownerComment(channelId, storyboardId, await body(request)))),

    /** POST `{ text }`: a reply in the comment's thread. */
    reply: (request: Request, context: Params<Base & { storyboardId: string; commentId: string }>) =>
      guarded(context, async ({ channelId, storyboardId, commentId }) => {
        const input = await body(request);
        return NextResponse.json(await deps.service().ownerReply(channelId, storyboardId, { ...(input && typeof input === "object" ? input : {}), commentId }));
      }),

    /** PATCH `{ state: open | resolved }`. */
    setState: (request: Request, context: Params<Base & { storyboardId: string; commentId: string }>) =>
      guarded(context, async ({ channelId, storyboardId, commentId }) => {
        const input = await body(request);
        await deps.service().ownerSetCommentState(channelId, storyboardId, { ...(input && typeof input === "object" ? input : {}), commentId });
        return NextResponse.json({ ok: true });
      }),

    /** POST `{ kind: approved | changes_requested, versionNumber, note? }`. */
    decide: (request: Request, context: Params<Base & { storyboardId: string }>) =>
      guarded(context, async ({ channelId, storyboardId }) => NextResponse.json(await deps.service().ownerDecide(channelId, storyboardId, await body(request)))),

    /** BL-184 stage 2 (B4): the channel's "first/last-frame video needs an approved storyboard" setting. */
    gate: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().gateSetting(channelId))),

    /** PUT `{ requireApproved }`. */
    setGate: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().setGateSetting(channelId, await body(request)))),

    /** The keyframe's image as this computer has it (even when it differs from the frozen sha256: review is not blocked). */
    keyframe: (_request: Request, context: Params<Base & { storyboardId: string; version: string; keyframeId: string }>) =>
      guarded(context, async ({ channelId, storyboardId, version, keyframeId }) => {
        const number = Number(version);
        if (!Number.isInteger(number) || number < 1) return NextResponse.json({ error: "validation_failed", message: "version must be a whole number" }, { status: 400 });
        const found = await deps.service().keyframeFile(channelId, storyboardId, number, keyframeId);
        if (!found) return NextResponse.json({ error: "storyboard_file_unavailable", message: "This keyframe's file is not on this computer" }, { status: 404 });
        const type = IMAGE_TYPES[path.extname(found.file).toLowerCase()];
        if (!type) return NextResponse.json({ error: "validation_failed", message: "Not an image this screen shows (jpg, png, webp)" }, { status: 415 });
        const bytes = await deps.readFile(found.path);
        return new Response(Buffer.from(bytes), { headers: { "content-type": type, "content-length": String(bytes.byteLength), "cache-control": "no-store" } });
      }),
  };
}
