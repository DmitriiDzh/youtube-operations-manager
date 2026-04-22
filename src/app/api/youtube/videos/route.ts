import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube, getRecentVideos } from "@/lib/youtube";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  if (searchParams.get("debug") === "1") {
    const youtube = await getAuthenticatedYoutube(session.user.id);
    const channels = await youtube.channels.list({
      part: ["snippet", "contentDetails", "statistics"],
      mine: true,
    });
    return NextResponse.json({
      channels: channels.data.items?.map((c) => ({
        id: c.id,
        title: c.snippet?.title,
        videoCount: c.statistics?.videoCount,
        uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads,
      })),
    });
  }

  const videos = await getRecentVideos(session.user.id);
  return NextResponse.json(videos);
}
