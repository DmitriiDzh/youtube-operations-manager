import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelConnectionsCore } from "@/lib/channel-connections";

/**
 * Read-only list for the Settings "Channels" section (`docs/decisions/0010-persistent-channel-connections.md`).
 * Never includes a token -- `listConnectedChannels`'s public shape omits it entirely.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const channels = await createChannelConnectionsCore().listConnectedChannels(session.user.id);
  return NextResponse.json({ channels });
}
