import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../shared";

/**
 * BL-143 phase 3 (AC-GP3-02): tracks waiting for the owner's verdict. BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-01/02, ADR 0031):
 * the top-level counts are the ACTIVE channel's (the Media badge); `channels` is the open work of every channel connected
 * here -- counts and notice names only, never tracks or files -- for the channel switcher and the bell. A local read.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [activeChannelId, connected] = await Promise.all([activeChannelOf(userId), createChannelConnectionsCore().listConnectedChannels(userId)]);
    return NextResponse.json(await createGenerationPlansCore().channelSummary({ activeChannelId, connectedChannelIds: connected.map((c) => c.channelId) }));
  } catch (error) {
    return planErrorResponse(error);
  }
}
