import { getServerSession } from "next-auth";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { beginAllChannelsRun, createAnalyticsCore, endAllChannelsRun } from "@/lib/analytics";
import { createChannelAccessCore } from "@/lib/channel-access";
import { DomainError } from "@/lib/analytics/contracts";
import { getOperationRegistry, runTrackedOperation } from "@/lib/operation-progress";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { getAnalyticsDataSync, importPeersFirst } from "@/lib/analytics-data-sync";
import { createVideoCommentsCore } from "@/lib/video-comments";

export type AutoCollectAllDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createAnalyticsCore>, "runAutoCollectionForChannels" | "runHistoryCatchUp" | "collectDueMilestones" | "collectDueBreakdowns" | "collectDueSearchTerms">;
  getActiveChannelId: (userId: string) => Promise<string | null>;
  /** Runs work after the response is sent (Next's `after`); injectable for tests. */
  runAfter: (work: () => Promise<void>) => void;
  /** The process-wide single all-channels run (analytics/auto-collect-all.ts); injectable for tests. */
  beginRun: () => boolean;
  endRun: () => void;
  /** BL-151: import the other devices' rows before deciding what is stale. `pending` = still importing: do not collect now. */
  importPeers?: () => Promise<{ imported: number; pending: boolean }>;
  /** BL-151: publish this device's new rows once the background collection is done. */
  publishLocal?: () => Promise<unknown>;
  /** BL-171: the own-video comments (their own module, a Data API read), after the analytics steps. */
  collectDueComments?: (input: { credentialRef: { userId: string }; channelId: string }) => Promise<unknown>;
};

// BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): the dashboard's automatic Analytics collection, once per
// load, for every connected channel (analytics/auto-collect-all.ts). Replaces the dashboard's per-channel
// auto-collect + weekly-report calls; those routes stay for anything else that calls them. A real local mutation, so
// src/proxy.ts gates it like any other POST.
// - The session's active channel is collected while the dashboard waits, as before; every other channel, and then the
//   BL-118 history catch-up of every channel with a gap, run after the response, one after another (a long job must
//   not hold the dashboard).
// - One all-channels run at a time per process: a reload or a second tab while one is still going does nothing.
// - The active channel is resolved once and used throughout; the response holds only that channel (ADR 0004).
export function createAutoCollectAllHandler(
  deps: AutoCollectAllDeps = {
    getSession: () => getServerSession(authOptions),
    core: createAnalyticsCore(),
    getActiveChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    runAfter: (work) => after(work),
    beginRun: beginAllChannelsRun,
    endRun: endAllChannelsRun,
    importPeers: importPeersFirst,
    publishLocal: () => getAnalyticsDataSync().publishLocal(),
    collectDueComments: (input) => createVideoCommentsCore().collectDueComments(input),
  }
) {
  return async function POST() {
    const session = await deps.getSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!deps.beginRun()) return NextResponse.json({ channels: [], catchUpScheduled: false, inProgress: true });
    let handedOff = false;
    try {
      const peers = deps.importPeers ? await deps.importPeers() : { imported: 0, pending: false };
      if (peers.pending) {
        // The other computer's rows are still arriving: collecting now would race that import (plan: wait for the next load).
        // The run is released by the `finally` below (nothing was handed off).
        return NextResponse.json({ channels: [], catchUpScheduled: false, importedFromPeers: 0, importPending: true });
      }
      const importedFromPeers = peers.imported;
      const activeChannelId = await deps.getActiveChannelId(sessionUserId);
      const active = await deps.core.runAutoCollectionForChannels({ sessionUserId, activeChannelId, which: "active" });

      deps.runAfter(async () => {
        try {
          const background = await deps.core.runAutoCollectionForChannels({ sessionUserId, activeChannelId, which: "background" });
          for (const { channelId, credentialRef } of [...active.catchUps, ...background.catchUps]) {
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
          // BL-166: each collected channel's due day-7 / day-28 milestones, after the history (both are background reads).
          for (const { channelId, credentialRef } of [...active.milestones, ...background.milestones]) {
            try {
              await deps.core.collectDueMilestones({ credentialRef, channelId });
            } catch {
              // Reads off, quota, sign-in: nothing was counted against the milestones; the next dashboard open tries again.
            }
          }
          // BL-168: then each such channel's stored traffic sources and devices (a background read too; one channel failing never
          // stops the next one).
          for (const { channelId, credentialRef } of [...active.milestones, ...background.milestones]) {
            try {
              await deps.core.collectDueBreakdowns({ credentialRef, channelId });
            } catch {
              // Reads off, quota, sign-in, an outage: nothing was counted; the next dashboard open tries again.
            }
          }
          // BL-169: then each such channel's stored search terms (the same rules; one channel failing never stops the next one).
          for (const { channelId, credentialRef } of [...active.milestones, ...background.milestones]) {
            try {
              await deps.core.collectDueSearchTerms({ credentialRef, channelId });
            } catch {
              // Reads off, quota, sign-in, an outage: nothing was counted; the next dashboard open tries again.
            }
          }
          // BL-171: then each such channel's own-video comments, once a Pacific day (a Data API read; one channel failing never stops
          // the next one).
          for (const { channelId, credentialRef } of [...active.milestones, ...background.milestones]) {
            try {
              await deps.collectDueComments?.({ credentialRef, channelId });
            } catch {
              // Reads off, quota, sign-in, an outage: the day is not marked; the next dashboard open tries again.
            }
          }
        } catch {
          // Background work is best-effort; the next dashboard load tries again.
        } finally {
          deps.endRun();
          await deps.publishLocal?.().catch(() => undefined);
        }
      });
      handedOff = true;

      return NextResponse.json({ channels: active.channels, catchUpScheduled: active.catchUps.length > 0, importedFromPeers });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    } finally {
      // The background part releases the run itself; release here only if it was never handed off.
      if (!handedOff) deps.endRun();
    }
  };
}

export const POST = createAutoCollectAllHandler();
