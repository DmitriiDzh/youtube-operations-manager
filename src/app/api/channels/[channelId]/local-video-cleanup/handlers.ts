import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getLocalVideoCleanupCore, type LocalVideoCleanup } from "@/lib/local-video-cleanup";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type RouteContext = { params: Promise<{ channelId: string }> };

export type LocalVideoCleanupRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<unknown>;
  core: () => Pick<LocalVideoCleanup, "view" | "setEnabled">;
};

function defaultDeps(): LocalVideoCleanupRouteDeps {
  const channelAccess = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: (args) => channelAccess.assertActiveChannel(args),
    core: getLocalVideoCleanupCore,
  };
}

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-238 (ADR 0058 §5, §6): the channel's local video cleanup on THIS computer -- GET the card (switch, freed space, waits, the
 * last deletes and refusals), PUT `{ enabled }` the owner's switch. The Web UI only: no MCP or agent tool reaches it. Local only;
 * the active channel only (ADR 0004). PUT passes `src/proxy.ts`'s device mutation gate like every mutating /api route.
 */
export function createLocalVideoCleanupHandlers(deps: LocalVideoCleanupRouteDeps = defaultDeps()) {
  async function guarded(params: RouteContext["params"], run: (channelId: string) => Promise<NextResponse>): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId: session.user.id, channelId });
      return await run(channelId);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return {
    GET: (_request: Request, { params }: RouteContext) => guarded(params, async (channelId) => NextResponse.json(await deps.core().view(channelId))),
    PUT: (request: Request, { params }: RouteContext) =>
      guarded(params, async (channelId) => {
        const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
        if (!body || typeof body !== "object" || typeof body.enabled !== "boolean" || Object.keys(body).length !== 1) {
          return NextResponse.json({ error: "validation_failed", message: "Body must be { enabled: boolean }" }, { status: 400 });
        }
        await deps.core().setEnabled(channelId, body.enabled);
        return NextResponse.json(await deps.core().view(channelId));
      }),
  };
}
