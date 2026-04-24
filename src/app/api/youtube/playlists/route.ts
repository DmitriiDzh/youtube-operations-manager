import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlaylistManagementCore } from "@/lib/playlist-management";

type PlaylistsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createPlaylistManagementCore>, "listPlaylists">;
};

export function createPlaylistsGetHandler(
  deps: PlaylistsRouteDeps = {
    getSession: () => getServerSession(authOptions),
    core: createPlaylistManagementCore(),
  }
) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await deps.core.listPlaylists({
      credentialRef: { userId: session.user.id },
    });

    return NextResponse.json(result.playlists);
  };
}

export const GET = createPlaylistsGetHandler();
