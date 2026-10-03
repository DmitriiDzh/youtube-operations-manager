import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelConnectionsCore } from "@/lib/channel-connections";

// One core for the process, so its short-lived cache of real token checks survives between requests.
const core = createChannelConnectionsCore();

/**
 * BL-115 -- health of every connected channel's stored Google grant, for the dashboard's re-login prompt and the
 * Settings badges (`docs/roadmap/plans/CONNECTION_REAUTH_PLAN.md`). One token-endpoint call per connection
 * (cached ~10 min; `?refresh=1` bypasses the cache, used right after a failed channel load). No YouTube quota. The
 * public shape carries no token and no internal user id. GET: never gated by src/proxy.ts's mutation check.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  const health = await core.getConnectionHealth(session.user.id, { forceRefresh });
  return NextResponse.json({ health });
}
