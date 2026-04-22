import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { addVideoToPlaylist } from "@/lib/youtube";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { videoIds, playlistId } = await request.json();
  if (!videoIds?.length || !playlistId) {
    return NextResponse.json(
      { error: "Missing videoIds or playlistId" },
      { status: 400 }
    );
  }

  let added = 0;
  for (const videoId of videoIds) {
    try {
      await addVideoToPlaylist(session.user.id, videoId, playlistId);
      added++;
    } catch {
      // Video might already be in the playlist
    }
  }

  return NextResponse.json({ added });
}
