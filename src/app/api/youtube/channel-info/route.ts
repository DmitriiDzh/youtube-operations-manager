import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube } from "@/lib/youtube";

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

  return NextResponse.json({
    channel: {
      id: channel.id,
      title: channel.snippet?.title,
      thumbnail: channel.snippet?.thumbnails?.default?.url,
      videoCount: channel.statistics?.videoCount,
    },
  });
}
