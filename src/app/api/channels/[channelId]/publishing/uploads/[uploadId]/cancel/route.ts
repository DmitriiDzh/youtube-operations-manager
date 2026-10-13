import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { cancelUpload } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../../../video-metadata/error-status";

export type CancelUploadDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  cancel: (channelId: string, uploadId: string) => Promise<boolean>;
};

/** BL-182 stage 2: cancels an upload that has not reached YouTube (queued, or paused before its last byte). 409 otherwise. */
export function createCancelUploadHandler(
  deps: CancelUploadDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    cancel: (channelId, uploadId) => cancelUpload(channelId, uploadId),
  }
) {
  return async function POST(_request: Request, { params }: { params: Promise<{ channelId: string; uploadId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, uploadId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      if (!(await deps.cancel(channelId, uploadId))) {
        return NextResponse.json({ error: "upload_not_cancellable", message: "Only an upload that has not reached YouTube can be cancelled." }, { status: 409 });
      }
      return NextResponse.json({ cancelled: true });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createCancelUploadHandler();
