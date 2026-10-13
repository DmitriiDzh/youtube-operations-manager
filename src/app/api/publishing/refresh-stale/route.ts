import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { listChannelConnections } from "@/lib/channel-fanout";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";

/** A channel's videos are refreshed for the calendar and the reminder when its last sync is older than this. */
export const PUBLISHING_REFRESH_AFTER_MS = 6 * 3_600_000;

export type RefreshStaleDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelId: (userId: string) => Promise<string | null>;
  connections: () => Promise<Array<{ channelId: string; connectedUserId: string | null }>>;
  lastSyncedAt: (channelId: string) => Promise<Date | null>;
  sync: (input: { userId: string; channelId: string }) => Promise<void>;
  clock: { now(): Date };
  /** In-process single flight (a reload or a second tab while a refresh still runs does nothing). */
  flag: { running: boolean };
};

const processFlag: { running: boolean } = ((globalThis as unknown as Record<symbol, { running: boolean } | undefined>)[
  Symbol.for("youtube-operations-manager.publishing-refresh-stale")
] ??= { running: false });

/**
 * BL-182 stage 1 (FO-REQ-0023 §4 D4; PUBLISHING_PLAN.md §2 stage 1 item 2): once per dashboard load, refresh the videos of every
 * connected channel OTHER than the active one whose last sync is older than 6 h, so the reminder in the bell does not rest on
 * stale data. The active channel is already synced on every load (`use-connected-channels`). Each channel is synced with its own
 * connected Google user (the BL-141 rule), one after another; the dashboard fires the request and does not wait for it. A channel
 * sync costs a few units (uploads playlist pages plus `videos.list` in fifties). The 60 s alert poll itself never calls YouTube.
 */
export function createRefreshStaleHandler(
  deps: RefreshStaleDeps = {
    getSession: () => getServerSession(authOptions),
    activeChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    connections: () => listChannelConnections(),
    lastSyncedAt: async (channelId) => (await createChannelVideoStoreAdapter().getChannel(channelId))?.lastSyncedAt ?? null,
    sync: async ({ userId, channelId }) => {
      await createChannelSyncCore().syncChannel({ credentialRef: { userId }, channelId });
    },
    clock: { now: () => new Date() },
    flag: processFlag,
  }
) {
  return async function POST(): Promise<NextResponse> {
    const session = await deps.getSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (deps.flag.running) return NextResponse.json({ refreshed: [], inProgress: true });
    deps.flag.running = true;
    const refreshed: string[] = [];
    const failed: Array<{ channelId: string; error: string }> = [];
    try {
      const [activeChannelId, connections] = await Promise.all([deps.activeChannelId(sessionUserId), deps.connections()]);
      for (const connection of connections) {
        if (connection.channelId === activeChannelId || !connection.connectedUserId) continue;
        const last = await deps.lastSyncedAt(connection.channelId);
        if (last && deps.clock.now().getTime() - last.getTime() <= PUBLISHING_REFRESH_AFTER_MS) continue;
        try {
          await deps.sync({ userId: connection.connectedUserId, channelId: connection.channelId });
          refreshed.push(connection.channelId);
        } catch (error) {
          // One channel failing never stops the others (AGENTS.md §M); its bell entry keeps showing the data age.
          failed.push({ channelId: connection.channelId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return NextResponse.json({ refreshed, failed });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    } finally {
      deps.flag.running = false;
    }
  };
}

export const POST = createRefreshStaleHandler();
