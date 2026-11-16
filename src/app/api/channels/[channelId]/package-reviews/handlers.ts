import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { packageReviewsForRoutes } from "@/composition/package-reviews";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { streamLocalFile } from "@/lib/local-file-response";
import { isOwnerBrowserRequest } from "@/lib/loopback-guard";
import type { PackageReviewsOwnerSurface } from "@/lib/package-reviews";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-257 (PACKAGE_REVIEW_PLAN.md stage 2, ADR 0070 §4, §6): the owner's review of the active channel's final release packages -- the
// list with the switch, the switch itself, his decision, and the package's own video and thumbnail (HTTP Range) for the player. A Web
// session and the ACTIVE channel are required (AGENTS.md §F); the media go to the owner's browser on this computer or, through the
// proxy's remote gate, on his phone (BL-251 amendment 2). No MCP path reaches these handlers (AC-PR-08 source scan).

export type PackageReviewRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => PackageReviewsOwnerSurface;
  /** The owner's own browser: this computer, or a remote request that passed the proxy's remote gate (never a foreign page). */
  isOwnerBrowser: (request: Request) => boolean;
};

const defaultDeps = (): PackageReviewRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  service: packageReviewsForRoutes,
  isOwnerBrowser: (request) => isOwnerBrowserRequest(request.headers), // AC-PR-15: the phone plays them too
});

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Context = { params: Promise<{ channelId: string }> };

export function createPackageReviewRouteHandlers(deps: PackageReviewRouteDeps = defaultDeps()) {
  /** The session's user on the active channel, or the answer to send instead. */
  async function guarded(context: Context, run: (channelId: string) => Promise<Response>): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await context.params;
      await deps.assertActiveChannel({ userId, channelId });
      return await run(channelId);
    } catch (error) {
      return errorResponse(error);
    }
  }

  function media(which: "video" | "thumbnail") {
    return (request: Request, context: Context) =>
      guarded(context, async (channelId) => {
        if (!deps.isOwnerBrowser(request)) return NextResponse.json({ error: "forbidden", message: "Local files are served to the owner's browser only" }, { status: 403 });
        const manifest = new URL(request.url).searchParams.get("manifest");
        const file = await deps.service().mediaFile(channelId, manifest, which);
        if (!file) return NextResponse.json({ error: "package_review_file_missing", message: "This package's file is not on this computer" }, { status: 404 });
        return streamLocalFile(file, file.type, request);
      });
  }

  return {
    /** GET: the switch and the channel's packages with their review state (pending first). */
    list: (_request: Request, context: Context) => guarded(context, async (channelId) => NextResponse.json(await deps.service().view(channelId))),
    /** PUT `{ required: boolean }`: the owner's switch. */
    setRequired: (request: Request, context: Context) =>
      guarded(context, async (channelId) => NextResponse.json(await deps.service().setRequired(channelId, await request.json().catch(() => null)))),
    /** POST `{ manifestSha256, kind: approved | returned | packaging_comment (BL-265), comment? }` (a return or a packaging comment needs a comment). */
    decide: (request: Request, context: Context) =>
      guarded(context, async (channelId) => NextResponse.json(await deps.service().decide(channelId, await request.json().catch(() => null)))),
    /** GET `?manifest=<sha256>`: the package's own video, with HTTP Range (the player seeks in a multi-GB episode); never its path. */
    video: media("video"),
    /** GET `?manifest=<sha256>`: the package's default thumbnail. */
    thumbnail: media("thumbnail"),
  };
}
