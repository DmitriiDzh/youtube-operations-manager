import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  getLiveWritesEnabled,
  getMcpConnectionEnabled,
  setLiveWritesEnabled,
  setMcpConnectionEnabled,
} from "@/lib/db";

/**
 * App-wide settings (Settings tab, owner instruction 2026-09-21). Two flags today:
 * - `liveWritesEnabled` -- Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09). Defaults off every
 *   process boot (`src/lib/db.ts`'s `initializeDatabase`), regardless of what was last saved;
 *   turning this on is layer 1 of the two-layer live-write barrier, not the write itself.
 * - `mcpConnectionEnabled` -- the single gate for whether an MCP client sees ANY tool at all
 *   (renamed and inverted from the earlier "MCP restricted mode", owner instruction 2026-09-21:
 *   "по началу MCP / агент от всего отключен"). Unlike `liveWritesEnabled`, this persists across
 *   process boots -- a one-time setup toggle, not reset every session. Takes effect the next
 *   time an MCP client spawns/reconnects the server process, not for an already-open MCP
 *   connection (an MCP server's tool set is fixed at construction time).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [liveWritesEnabled, mcpConnectionEnabled] = await Promise.all([
    getLiveWritesEnabled(),
    getMcpConnectionEnabled(),
  ]);

  return NextResponse.json({ liveWritesEnabled, mcpConnectionEnabled });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
  }

  if (typeof body.liveWritesEnabled === "boolean") {
    await setLiveWritesEnabled(body.liveWritesEnabled);
  }
  if (typeof body.mcpConnectionEnabled === "boolean") {
    await setMcpConnectionEnabled(body.mcpConnectionEnabled);
  }

  const [liveWritesEnabled, mcpConnectionEnabled] = await Promise.all([
    getLiveWritesEnabled(),
    getMcpConnectionEnabled(),
  ]);

  return NextResponse.json({ liveWritesEnabled, mcpConnectionEnabled });
}
