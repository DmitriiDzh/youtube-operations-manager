import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { releaseUnknownOutcome } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../../../video-metadata/error-status";

export type ReleaseUploadDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  release: (channelId: string, uploadId: string) => Promise<boolean>;
};

/**
 * BL-182 stage 2: the owner looked in Studio after an upload ended with an unknown outcome and found no video -- the package may be
 * approved again. Only for such a row (409 otherwise); the active channel only.
 */
export function createReleaseUploadHandler(
  deps: ReleaseUploadDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    release: (channelId, uploadId) => releaseUnknownOutcome(channelId, uploadId),
  }
) {
  return async function POST(_request: Request, { params }: { params: Promise<{ channelId: string; uploadId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, uploadId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      if (!(await deps.release(channelId, uploadId))) {
        return NextResponse.json({ error: "upload_not_releasable", message: "Only an upload whose outcome is unknown can be released." }, { status: 409 });
      }
      return NextResponse.json({ released: true });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createReleaseUploadHandler();
