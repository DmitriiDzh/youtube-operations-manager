import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createStoryboardsServiceForProduction, type StoryboardSummary } from "@/lib/storyboards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type StoryboardAlertsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelId: (userId: string) => Promise<string | null>;
  connectedChannelIds: (userId: string) => Promise<string[]>;
  list: (channelId: string) => Promise<StoryboardSummary[]>;
};

function defaultDeps(): StoryboardAlertsDeps {
  return {
    getSession: () => getServerSession(authOptions),
    activeChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    connectedChannelIds: async (userId) => (await createChannelConnectionsCore().listConnectedChannels(userId)).map((c) => c.channelId),
    list: (channelId) => createStoryboardsServiceForProduction().listForOwner(channelId),
  };
}

/**
 * BL-184 stage 1 (FO-REQ-0024 §4 D; STORYBOARD_PLAN.md §3 stage 1 item 4): per connected channel, the storyboards waiting for the
 * owner's review -- the Media badge (the active channel) and the bell (the others), the same family as `GET /api/publishing-alerts`.
 * A local read of the synced document, so a storyboard submitted on the other computer shows here after a sync.
 */
export function createStoryboardAlertsHandler(deps: StoryboardAlertsDeps = defaultDeps()) {
  return async (): Promise<NextResponse> => {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const [activeChannelId, channelIds] = await Promise.all([deps.activeChannelId(userId), deps.connectedChannelIds(userId)]);
      const settled = await Promise.allSettled(channelIds.map(async (channelId) => ({ channelId, list: await deps.list(channelId) })));
      const channels = settled.flatMap((r) => {
        if (r.status !== "fulfilled") return [];
        const waiting = r.value.list.filter((s) => s.state === "in_review");
        return waiting.length > 0 ? [{ channelId: r.value.channelId, waiting: waiting.length, storyboardId: waiting.length === 1 ? waiting[0].storyboardId : null }] : [];
      });
      return NextResponse.json({ activeChannelId, channels });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createStoryboardAlertsHandler();
