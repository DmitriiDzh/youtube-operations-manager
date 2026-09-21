import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  getLiveWritesEnabled,
  getMcpRestrictedModeEnabled,
  setLiveWritesEnabled,
  setMcpRestrictedModeEnabled,
} from "@/lib/db";

/**
 * App-wide settings (Settings tab, owner instruction 2026-09-21). Two flags today:
 * - `liveWritesEnabled` -- Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09). Defaults off every
 *   process boot (`src/lib/db.ts`'s `initializeDatabase`), regardless of what was last saved;
 *   turning this on is layer 1 of the two-layer live-write barrier, not the write itself.
 * - `mcpRestrictedModeEnabled` -- persisted counterpart to the `MCP_RESTRICTED_MODE` env var.
 *   Takes effect the next time an MCP client spawns/reconnects the server process, not for an
 *   already-open MCP connection (an MCP server's tool set is fixed at construction time).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [liveWritesEnabled, mcpRestrictedModeEnabled] = await Promise.all([
    getLiveWritesEnabled(),
    getMcpRestrictedModeEnabled(),
  ]);

  return NextResponse.json({ liveWritesEnabled, mcpRestrictedModeEnabled });
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
  if (typeof body.mcpRestrictedModeEnabled === "boolean") {
    await setMcpRestrictedModeEnabled(body.mcpRestrictedModeEnabled);
  }

  const [liveWritesEnabled, mcpRestrictedModeEnabled] = await Promise.all([
    getLiveWritesEnabled(),
    getMcpRestrictedModeEnabled(),
  ]);

  return NextResponse.json({ liveWritesEnabled, mcpRestrictedModeEnabled });
}
