import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { listMediaJobsPool, type PoolMediaKind, type PoolView } from "@/lib/media-jobs-pool";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1): Media's one list of jobs -- RunPod and Gemini, this computer's and every other
// computer's. Session required (401). The channel is the session's ACTIVE channel, resolved here and never taken from the request
// (ADR 0004 (b), like Media's other lists); none while no channel is active. Read-only.

export type MediaJobsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelOf: (userId: string) => Promise<string | null>;
  list: (input: { channelId: string; kind: PoolMediaKind | null; limit: number }) => Promise<PoolView>;
};

const KINDS: readonly PoolMediaKind[] = ["audio", "image", "video"];
const MEDIA_JOBS_ROUTE_DEFAULT_LIMIT = 50;
const MEDIA_JOBS_ROUTE_MAX_LIMIT = 200;

export function createMediaJobsGetHandler(
  deps: MediaJobsRouteDeps = {
    getSession: () => getServerSession(authOptions),
    activeChannelOf: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    list: listMediaJobsPool,
  }
) {
  return async function GET(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    const kindParam = url.searchParams.get("kind");
    if (kindParam !== null && !(KINDS as readonly string[]).includes(kindParam)) {
      return NextResponse.json({ error: "validation_failed", message: "kind must be audio, image or video" }, { status: 400 });
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? MEDIA_JOBS_ROUTE_DEFAULT_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MEDIA_JOBS_ROUTE_MAX_LIMIT) {
      return NextResponse.json({ error: "validation_failed", message: `limit must be a whole number from 1 to ${MEDIA_JOBS_ROUTE_MAX_LIMIT}` }, { status: 400 });
    }
    try {
      const channelId = await deps.activeChannelOf(session.user.id);
      if (!channelId) return NextResponse.json({ jobs: [], devices: [] } satisfies PoolView);
      return NextResponse.json(await deps.list({ channelId, kind: (kindParam as PoolMediaKind | null) ?? null, limit }));
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createMediaJobsGetHandler();
