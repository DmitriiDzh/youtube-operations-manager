import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { DomainError } from "@/lib/playlist-management/contracts";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";

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

    const { videoIds, playlistId } = await request.json();
    if (!videoIds?.length || !playlistId) {
      return NextResponse.json(
        { error: "Missing videoIds or playlistId" },
        { status: 400 }
      );
    }

    try {
      const result = await deps.core.addVideosToPlaylist({
        credentialRef: { userId: session.user.id },
        videoIds,
        playlistId,
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
