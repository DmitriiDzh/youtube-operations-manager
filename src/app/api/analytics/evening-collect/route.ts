import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { beginAllChannelsRun, createAnalyticsCore, endAllChannelsRun, type EveningChannelOutcome } from "@/lib/analytics";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getAnalyticsDataSync, importPeersFirst } from "@/lib/analytics-data-sync";

export type EveningCollectDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createAnalyticsCore>, "getEveningWindow" | "runEveningCollectionForChannels">;
  getActiveChannelId: (userId: string) => Promise<string | null>;
  /** The process-wide single all-channels run, shared with the daily auto-collection. */
  beginRun: () => boolean;
  endRun: () => void;
  /** BL-151: the other computer's collection first, so a channel it already re-collected this evening is not collected twice. */
  importPeers?: () => Promise<{ imported: number; pending: boolean }>;
  publishLocal?: () => Promise<unknown>;
  /** In-process memory of the local date whose evening is done for every channel; injectable for tests. */
  memo: { doneFor: string | null };
};

/** An outcome after which nothing more can happen for the channel this evening. */
function isFinal(outcome: EveningChannelOutcome): boolean {
  return outcome.outcome !== "skipped" || (outcome.reason !== "not_yet" && outcome.reason !== "quota_reserve");
}

const processMemo: { doneFor: string | null } = ((globalThis as unknown as Record<symbol, { doneFor: string | null } | undefined>)[
  Symbol.for("youtube-operations-manager.analytics-evening-done")
] ??= { doneFor: null });

// BL-181 (FO-REQ-0020 §2.3; plan REPORTING_BASIC_PLAN.md §2 item 7): the dashboard calls this every 5 minutes while it is visible.
// Before the evening boundary, or once every channel's evening is settled, it answers at once from local settings -- no lock, no
// peer import, no Google call. After the boundary each channel decides for itself (`runEveningCollectionIfDue`); it shares the
// daily run's process-wide lock so the two never collect side by side. The response holds only the active channel (ADR 0004).
export function createEveningCollectHandler(
  deps: EveningCollectDeps = {
    getSession: () => getServerSession(authOptions),
    core: createAnalyticsCore(),
    getActiveChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    beginRun: beginAllChannelsRun,
    endRun: endAllChannelsRun,
    importPeers: importPeersFirst,
    publishLocal: () => getAnalyticsDataSync().publishLocal(),
    memo: processMemo,
  }
) {
  return async function POST() {
    const session = await deps.getSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
      const window = await deps.core.getEveningWindow();
      if (!window.open || window.localDate === null) return NextResponse.json({ due: false });
      if (deps.memo.doneFor === window.localDate) return NextResponse.json({ due: false, done: true });
      if (!deps.beginRun()) return NextResponse.json({ due: true, inProgress: true });
      try {
        if (deps.importPeers && (await deps.importPeers()).pending) return NextResponse.json({ due: true, importPending: true });
        const activeChannelId = await deps.getActiveChannelId(sessionUserId);
        const { channels } = await deps.core.runEveningCollectionForChannels({ sessionUserId, activeChannelId });
        if (channels.some((c) => c.outcome === "collected")) void deps.publishLocal?.().catch(() => undefined);
        if (channels.every(isFinal)) deps.memo.doneFor = window.localDate;
        return NextResponse.json({ due: true, channels: channels.filter((c) => activeChannelId !== null && c.channelId === activeChannelId) });
      } finally {
        deps.endRun();
      }
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createEveningCollectHandler();
