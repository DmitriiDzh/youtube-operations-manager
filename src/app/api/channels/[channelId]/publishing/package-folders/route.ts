import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageComposerCore, type ComposerFolder } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PackageFoldersDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  listFolders: (channelId: string) => Promise<ComposerFolder[]>;
};

/**
 * BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md): the active channel's video folders (`04 Videos/<month>/<MMDD Vn>`) with
 * their files, for «Новый пакет». Read-only: no YouTube call, nothing on disk changed.
 */
export function createPackageFoldersHandler(
  deps: PackageFoldersDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    listFolders: (channelId) => createPackageComposerCore().listFolders(channelId),
  }
) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json({ folders: await deps.listFolders(channelId) });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createPackageFoldersHandler();
