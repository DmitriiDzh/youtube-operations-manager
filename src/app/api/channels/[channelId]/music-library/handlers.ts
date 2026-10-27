import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createMusicLibraryServiceForProduction, type MusicLibraryResult } from "@/lib/music-library";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-229 part A (MUSIC_LIBRARY_PLAN.md §2): Media → «Музыка» → «Библиотека по жанрам» -- the factory's library snapshot of the
// channel. A Web session and the ACTIVE channel are required, like the neighbouring channel routes (AGENTS.md §F); the channel in
// the path is used only to look up that channel's own workspace on this computer (AC-ML-07). Read-only.

export type MusicLibraryRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  read: (channelId: string) => Promise<MusicLibraryResult>;
};

const defaultDeps = (): MusicLibraryRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  read: (channelId) => createMusicLibraryServiceForProduction().read(channelId),
});

export function createMusicLibraryRouteHandlers(deps: MusicLibraryRouteDeps = defaultDeps()) {
  return {
    async get(_request: Request, context: { params: Promise<{ channelId: string }> }): Promise<Response> {
      const session = await deps.getSession();
      const userId = session?.user?.id;
      if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await context.params;
        await deps.assertActiveChannel({ userId, channelId });
        return NextResponse.json(await deps.read(channelId));
      } catch (error) {
        if (error instanceof DomainError) {
          return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
        }
        return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
      }
    },
  };
}
