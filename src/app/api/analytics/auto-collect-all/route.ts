import { getServerSession } from "next-auth";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getOperationRegistry, runTrackedOperation } from "@/lib/operation-progress";

export type AutoCollectAllDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createAnalyticsCore>, "runAutoCollectionForAllChannels" | "runHistoryCatchUp">;
  getActiveChannelId: (userId: string) => Promise<string | null>;
  /** Runs work after the response is sent (Next's `after`); injectable for tests. */
  runAfter: (work: () => Promise<void>) => void;
};

// BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): the dashboard's automatic Analytics collection, once per
// load, for every connected channel (analytics/auto-collect-all.ts). Replaces the dashboard's per-channel
// auto-collect + weekly-report calls; those routes stay for anything else that calls them. A real local mutation, so
// src/proxy.ts gates it like any other POST. The BL-118 history catch-up of every channel with a gap runs after the
// response (a long job must not hold the dashboard), one channel after another, each as its own tracked operation. The
// response holds only the session's active channel (ADR 0004).
export function createAutoCollectAllHandler(
  deps: AutoCollectAllDeps = {
    getSession: () => getServerSession(authOptions),
    core: createAnalyticsCore(),
    getActiveChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    runAfter: (work) => after(work),
  }
) {
  return async function POST() {
    const session = await deps.getSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
      const { channels, catchUps } = await deps.core.runAutoCollectionForAllChannels({ sessionUserId });
      if (catchUps.length > 0) {
        deps.runAfter(async () => {
          for (const { channelId, credentialRef } of catchUps) {
            try {
              await runTrackedOperation({
                registry: getOperationRegistry(),
                kind: "analytics-backfill",
                channelId,
                title: "Collecting earlier analytics history",
                cancellable: false,
                work: (progress) => deps.core.runHistoryCatchUp({ credentialRef, channelId }, { progress }),
                messageFor: (done) => (done.ranCatchUp ? `${done.videosQueried} video(s) back-filled.` : "Nothing to back-fill."),
              });
            } catch {
              // Already running, reads switched off, quota reserve: planned again on the next dashboard open.
            }
          }
        });
      }
      const activeChannelId = await deps.getActiveChannelId(sessionUserId);
      return NextResponse.json({
        channels: channels.filter((c) => activeChannelId !== null && c.channelId === activeChannelId),
        catchUpScheduled: activeChannelId !== null && catchUps.some((c) => c.channelId === activeChannelId),
      });
    } catch (error) {
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

export const POST = createAutoCollectAllHandler();
