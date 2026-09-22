import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube } from "@/lib/youtube-read-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";

const channelAccess = createChannelAccessCore();

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const youtube = await getAuthenticatedYoutube(session.user.id);
  const res = await youtube.channels.list({
    part: ["snippet", "statistics"],
    mine: true,
  });

  const channel = res.data.items?.[0];
  if (!channel) {
    return NextResponse.json({ channel: null });
  }

  // This is the one place the Web UI learns, for free, which channel the live OAuth session
  // actually grants access to right now -- persisting it here is what keeps `selectedChannelId`
  // (docs/decisions/0004-active-channel-read-scoping.md) accurate for the read-scoping filter,
  // without requiring a separate "select active channel" UI step or a live API call on every
  // read-list request.
  if (channel.id) {
    await channelAccess.activateChannel({ userId: session.user.id, channelId: channel.id });
  }

  return NextResponse.json({
    channel: {
      id: channel.id,
      title: channel.snippet?.title,
      thumbnail: channel.snippet?.thumbnails?.default?.url,
      videoCount: channel.statistics?.videoCount,
    },
  });
}
