import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageScanCore } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../../video-metadata/error-status";

export type PackageThumbnailDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  readThumbnail: (channelId: string, relativePath: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
};

/**
 * BL-182 stage 2: a package's thumbnail for the preview (`?path=` relative to the workspace, under `04 Videos/`, a JPEG or PNG by
 * its first bytes). The active channel only; nothing else in the workspace is served.
 */
export function createPackageThumbnailHandler(
  deps: PackageThumbnailDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    readThumbnail: (channelId, relativePath) => createPackageScanCore().readThumbnail(channelId, relativePath),
  }
) {
  return async function GET(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      const relativePath = new URL(request.url).searchParams.get("path") ?? "";
      const image = await deps.readThumbnail(channelId, relativePath);
      if (!image) return NextResponse.json({ error: "not_found", message: "No package thumbnail at this path" }, { status: 404 });
      return new NextResponse(Buffer.from(image.bytes), { headers: { "content-type": image.contentType, "cache-control": "private, max-age=60" } });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createPackageThumbnailHandler();
