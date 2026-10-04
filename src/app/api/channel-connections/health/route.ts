import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelConnectionsCore, type ConnectionHealth } from "@/lib/channel-connections";
import { createCloudConnectionCore } from "@/lib/cloud-connection";

// One core for the process, so its short-lived cache of real token checks survives between requests.
const core = createChannelConnectionsCore();
// Same for the Cloud grant: a core built per request would start with an empty cache and call Google on every page load.
const cloudCore = createCloudConnectionCore();

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
  const health: ConnectionHealth[] = await core.getConnectionHealth(session.user.id, { forceRefresh });

  // BL-126: the one Google Cloud grant (quota statistics) is checked by the same rules and listed beside the channels.
  // A failure here only leaves it out, never the channel rows.
  try {
    const cloud = await cloudCore.getHealth({ forceRefresh });
    if (cloud.connected) {
      health.push({
        kind: "cloud",
        channelId: "google-cloud-connection",
        title: "Google Cloud (quota statistics)",
        connectedEmail: cloud.connectedEmail,
        isActive: false,
        state: cloud.state,
        ageDays: cloud.ageDays,
        daysLeft: cloud.daysLeft,
        checkedAt: cloud.checkedAt,
      });
    }
  } catch {
    // quiet by design
  }

  return NextResponse.json({ health });
}
