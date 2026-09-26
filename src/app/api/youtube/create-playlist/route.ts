import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { DomainError } from "@/lib/playlist-management/contracts";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../video-metadata/parse-json-body";

type CreatePlaylistRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createPlaylistManagementCore>, "createPlaylist">;
};

export function createCreatePlaylistPostHandler(
  deps: CreatePlaylistRouteDeps = {
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
        title?: string;
        description?: string;
        privacyStatus?: string;
      };
      const { title, description, privacyStatus } = body;
      if (!title?.trim()) {
        return NextResponse.json({ error: "Title is required" }, { status: 400 });
      }

      const result = await deps.core.createPlaylist({
        credentialRef: { userId: session.user.id },
        title: title.trim(),
        description,
        privacyStatus,
      });

      return NextResponse.json(result.playlist, { status: 201 });
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

export const POST = createCreatePlaylistPostHandler();
