import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { DomainError } from "@/lib/playlist-management/contracts";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../video-metadata/parse-json-body";

type AddToPlaylistRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createPlaylistManagementCore>, "addVideosToPlaylist">;
};

export function createAddToPlaylistPostHandler(
  deps: AddToPlaylistRouteDeps = {
    getSession: () => getServerSession(authOptions),
    core: createPlaylistManagementCore(),
  }
) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const body = (await parseVideoMetadataJsonBody(request)) as {
        videoIds?: string[];
        playlistId?: string;
        expectedChannelId?: string;
      };
      const { videoIds, playlistId, expectedChannelId } = body;
      if (!videoIds?.length || !playlistId || !expectedChannelId) {
        return NextResponse.json(
          { error: "Missing videoIds, playlistId, or expectedChannelId" },
          { status: 400 }
        );
      }

      const result = await deps.core.addVideosToPlaylist({
        credentialRef: { userId: session.user.id },
        videoIds,
        playlistId,
        expectedChannelId,
      });

      return NextResponse.json({ added: result.added });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

export const POST = createAddToPlaylistPostHandler();
