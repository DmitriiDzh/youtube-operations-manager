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
  importPeers?: () => Promise<{ imported: number; pending: boolean }>;
  publishLocal?: () => Promise<unknown>;
  /** BL-196: whether any channel is due under the `onlyIfDue` rule (read only); false answers before the peers' import. */
  isAnyDue?: (sessionUserId: string) => Promise<boolean>;
};

// BL-141 (owner, Telegram 2026-10-06, msgs 1864/1865): the dashboard's automatic Reach check for every connected
// channel, each with its own Google user's token (reach-reports/services.ts `syncAllReachReports`). A local-state
// mutation that also creates a channel's Reporting job on first run, so src/proxy.ts gates it like any other POST.
// Body: `{ onlyIfDue?: boolean }` -- the dashboard sets it (each channel at most every 6 hours). The response holds only
// the session's active channel's outcome (ADR 0004: a session sees only its active channel); every other channel's
// outcome is recorded in its own sync-attempt row, shown in its Analytics status block when it is active.
let sharedCore: ReturnType<typeof createReachReportsCore> | null = null;
/** One reach core for the route's default deps (the sync and the BL-196 "anything due?" check use the same one). */
function defaultCore() {
  return (sharedCore ??= createReachReportsCore());
}

export function createReachSyncAllHandler(
  deps: ReachSyncAllDeps = {
    getSession: () => getServerSession(authOptions),
    core: defaultCore(),
    getActiveChannelId: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    importPeers: importPeersFirst,
    publishLocal: () => getAnalyticsDataSync().publishLocal(),
    isAnyDue: (sessionUserId) => defaultCore().isAnyReachSyncDue({ sessionUserId }),
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
      // BL-196 (FAST_STARTUP_PLAN.md §2 D): nothing due -> answer before the other computer's import (a shared-folder scan). A failing
      // check counts as due, so the usual path runs.
      if (onlyIfDue && deps.isAnyDue && !(await deps.isAnyDue(session.user.id).catch(() => true))) {
        return NextResponse.json({ channels: [] });
      }
      if (onlyIfDue && deps.importPeers && (await deps.importPeers()).pending) {
        // The other computer's rows are still arriving: the automatic check waits for the next load (plan).
        return NextResponse.json({ channels: [], importPending: true });
      }
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
