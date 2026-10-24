import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { listWorkerActionLogEntries, type WorkerActionLogEntry } from "@/lib/db";

// BL-215 (docs/roadmap/plans/WORKER_CAPABILITIES_PLAN.md AC-WK-08, ADR 0048): the owner's read of one channel's worker log on this
// computer, for its row in Settings → Channels (every connected channel, not only the active one -- like the channel's agent token
// on the same row). Read-only; the rows are selected by this channel id, so another channel's rows never appear. The log itself is
// written by the channel session's MCP wrapper.

/** How many of the newest rows the Settings list shows. */
export const WORKER_ACTIONS_SHOWN = 100;

export type WorkerActionsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  list: (channelId: string, limit: number) => Promise<WorkerActionLogEntry[]>;
};

const defaultDeps: WorkerActionsRouteDeps = {
  getSession: () => getServerSession(authOptions),
  list: (channelId, limit) => listWorkerActionLogEntries(channelId, limit),
};

export function createWorkerActionsGetHandler(deps: WorkerActionsRouteDeps = defaultDeps) {
  return async function GET(_request: Request, context: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await context.params;
      const rows = await deps.list(channelId, WORKER_ACTIONS_SHOWN);
      return NextResponse.json({
        actions: rows.map((row) => ({
          at: row.at.toISOString(),
          tool: row.tool,
          target: row.target,
          detail: row.detail,
          outcome: row.outcome,
          errorCode: row.errorCode,
        })),
      });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}
