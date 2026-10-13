import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createPublishingCalendarCore, type PublishingAlert } from "@/lib/publishing";

export type PublishingAlertsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelId: (userId: string) => Promise<string | null>;
  connectedChannelIds: (userId: string) => Promise<string[]>;
  alertFor: (channelId: string) => Promise<PublishingAlert | null>;
};

export function defaultPublishingAlertsDeps(): PublishingAlertsDeps {
  const calendar = createPublishingCalendarCore();
  return {
    getSession: () => getServerSession(authOptions),
    activeChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    connectedChannelIds: async (userId) => (await createChannelConnectionsCore().listConnectedChannels(userId)).map((c) => c.channelId),
    alertFor: (channelId) => calendar.getAlert({ channelId }),
  };
}

/**
 * BL-182 stage 1 (FO-REQ-0023 §4 D): every connected channel's publishing coverage, for the «Контент» badge (the active channel)
 * and the bell (the others) -- the same family as `GET /api/localization-alerts`. Derived from the local copy on every poll, so
 * the reminder goes away once enough videos are scheduled; `lastSyncedAt` comes with it so a stale copy is never shown as
 * current. A local read: never a YouTube call (the refresh is `POST /api/publishing/refresh-stale`, once per dashboard load).
 */
export function createPublishingAlertsHandler(deps: PublishingAlertsDeps = defaultPublishingAlertsDeps()) {
  return async (): Promise<NextResponse> => {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const [activeChannelId, channelIds] = await Promise.all([deps.activeChannelId(userId), deps.connectedChannelIds(userId)]);
      const settled = await Promise.allSettled(channelIds.map((channelId) => deps.alertFor(channelId)));
      const channels = settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
      return NextResponse.json({ activeChannelId, channels });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createPublishingAlertsHandler();
