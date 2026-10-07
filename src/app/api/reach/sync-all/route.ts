import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createReachReportsCore } from "@/lib/reach-reports";
import { getAnalyticsDataSync, importPeersFirst } from "@/lib/analytics-data-sync";

export type ReachSyncAllDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createReachReportsCore>, "syncAllReachReports">;
  getActiveChannelId: (userId: string) => Promise<string | null>;
  /** BL-151: the other devices' reach rows and check times first, so a channel they checked recently is not due here. */
  importPeers?: () => Promise<number>;
  publishLocal?: () => Promise<unknown>;
};

// BL-141 (owner, Telegram 2026-10-06, msgs 1864/1865): the dashboard's automatic Reach check for every connected
// channel, each with its own Google user's token (reach-reports/services.ts `syncAllReachReports`). A local-state
// mutation that also creates a channel's Reporting job on first run, so src/proxy.ts gates it like any other POST.
// Body: `{ onlyIfDue?: boolean }` -- the dashboard sets it (each channel at most every 6 hours). The response holds only
// the session's active channel's outcome (ADR 0004: a session sees only its active channel); every other channel's
// outcome is recorded in its own sync-attempt row, shown in its Analytics status block when it is active.
export function createReachSyncAllHandler(
  deps: ReachSyncAllDeps = {
    getSession: () => getServerSession(authOptions),
    core: createReachReportsCore(),
    getActiveChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    importPeers: importPeersFirst,
    publishLocal: () => getAnalyticsDataSync().publishLocal(),
  }
) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let onlyIfDue = false;
    try {
      const body = (await request.json()) as { onlyIfDue?: unknown };
      onlyIfDue = body?.onlyIfDue === true;
    } catch {
      // No/invalid body: check every channel now.
    }
    try {
      // Only for the automatic due-check: an explicit "check now" checks regardless of the other computer.
      if (onlyIfDue) await deps.importPeers?.();
      const { channels } = await deps.core.syncAllReachReports({ onlyIfDue, sessionUserId: session.user.id });
      void deps.publishLocal?.().catch(() => undefined);
      const activeChannelId = await deps.getActiveChannelId(session.user.id);
      return NextResponse.json({ channels: channels.filter((c) => activeChannelId !== null && c.channelId === activeChannelId) });
    } catch (error) {
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

export const POST = createReachSyncAllHandler();
