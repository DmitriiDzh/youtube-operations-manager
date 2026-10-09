import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { listProducerCallLogEntries, listStoredChannels } from "@/lib/db";

/** How many of the newest Producer calls the Settings card shows. */
const PRODUCER_CALLS_SHOWN = 30;

type ProducerCallsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  listCalls: (limit: number) => Promise<Array<{ at: Date; tool: string; channelId: string | null; outcome: "ok" | "error"; errorCode: string | null }>>;
  channelTitles: () => Promise<Map<string, string>>;
};

const defaultDeps: ProducerCallsRouteDeps = {
  getSession: () => getServerSession(authOptions),
  listCalls: (limit) => listProducerCallLogEntries(limit),
  channelTitles: async () => new Map((await listStoredChannels()).map((channel) => [channel.channelId, channel.title])),
};

// BL-161 (FO-REQ-0012 §2.4) -- operator-only: what the Producer looked at on this device (newest first). A read; the log itself is
// written by the producer MCP endpoint.
export function createProducerCallsGetHandler(deps: ProducerCallsRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const [calls, titles] = await Promise.all([deps.listCalls(PRODUCER_CALLS_SHOWN), deps.channelTitles()]);
      return NextResponse.json({
        calls: calls.map((call) => ({
          at: call.at.toISOString(),
          tool: call.tool,
          channelId: call.channelId,
          channelTitle: call.channelId ? (titles.get(call.channelId) ?? null) : null,
          outcome: call.outcome,
          errorCode: call.errorCode,
        })),
      });
    } catch (error) {
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createProducerCallsGetHandler();
