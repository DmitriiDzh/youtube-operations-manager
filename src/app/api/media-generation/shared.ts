import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createMediaGenerationCore, DomainError, isDomainError, type MediaGenerationCore } from "@/lib/media-generation";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- operator-only routes for Settings → Media.
// Every handler: session required (401), thin translation to the one core, DomainError -> status
// map. No route ever returns a stored secret: the core's public shapes carry none (AC-P14-02/21).
// Mutating methods are covered by `src/proxy.ts`'s device-availability gate like every /api route.
// One wrapper for static routes (`mediaHandler`) and one for dynamic segments (`mediaParamsHandler`),
// so the 401 / DomainError / 500 translation exists exactly once (review round 4).

export type MediaRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: MediaGenerationCore;
  /** AGENTS.md §F: a body-supplied channelId must be one of this installation's connected channels. */
  isConnectedChannel: (channelId: string) => Promise<boolean>;
};

export function defaultMediaRouteDeps(): MediaRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    // The core is a process-wide singleton; resolved on first use so importing a route never builds it.
    get core() {
      return createMediaGenerationCore();
    },
    async isConnectedChannel(channelId) {
      const channels = await createChannelConnectionsCore().listConnectedChannels();
      return channels.some((c) => c.channelId === channelId);
    },
  };
}

export function mediaErrorResponse(error: unknown) {
  if (isDomainError(error)) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }) };
  }
}

/** The body as a plain object (an array or scalar counts as empty). */
export function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Refuses a channelId that is not one of this installation's connected channels (AGENTS.md §F). */
export async function assertConnectedChannel(deps: MediaRouteDeps, channelId: unknown): Promise<void> {
  if (typeof channelId !== "string" || !channelId || !(await deps.isConnectedChannel(channelId))) {
    throw new DomainError({ code: "channel_not_connected", message: "channelId is not one of this installation's connected channels", details: { channelId } });
  }
}

/** Wraps a handler: 401 without a session, DomainError mapping, 500 otherwise. */
export function mediaHandler(
  deps: MediaRouteDeps,
  run: (args: { core: MediaGenerationCore; request: Request; deps: MediaRouteDeps }) => Promise<NextResponse>
): (request: Request) => Promise<NextResponse> {
  return async function handler(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      return await run({ core: deps.core, request, deps });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
}

/** The same wrapper for a dynamic segment route (`[id]`): the awaited params are handed to `run`. */
export function mediaParamsHandler<P extends Record<string, string>>(
  deps: MediaRouteDeps,
  run: (args: { core: MediaGenerationCore; request: Request; params: P; userId: string; deps: MediaRouteDeps }) => Promise<NextResponse>
): (request: Request, context: { params: Promise<P> }) => Promise<NextResponse> {
  return async function handler(request: Request, context: { params: Promise<P> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      return await run({ core: deps.core, request, params: await context.params, userId: session.user.id, deps });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
}
