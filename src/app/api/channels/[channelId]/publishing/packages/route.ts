import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageScanCore, type PackageScanResult } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PublishingPackagesDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  scan: (channelId: string) => Promise<PackageScanResult>;
};

/**
 * BL-182 stage 2 (FO-REQ-0023 §4 A1, B1): the active channel's release packages found under `04 Videos/` of its workspace on this
 * computer, each checked again, with its state. Read-only: no YouTube call, nothing on disk changed; the active channel only.
 */
export function createPublishingPackagesHandler(
  deps: PublishingPackagesDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    scan: (channelId) => createPackageScanCore().scan(channelId),
  }
) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json(await deps.scan(channelId));
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createPublishingPackagesHandler();
