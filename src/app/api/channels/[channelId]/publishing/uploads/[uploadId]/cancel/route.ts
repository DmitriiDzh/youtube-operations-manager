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
  cancel: (input: { channelId: string; uploadId: string }, userId: string) => Promise<Record<string, unknown>>;
};

/**
 * BL-182 stage 2: cancels an upload that has not reached YouTube; BL-244 (ADR 0064): also stops one being sent before its last
 * chunk -- the session's user is the owner acting, through the queue control's one cancel. 409 `upload_not_cancellable` when it
 * may be on YouTube already, 404 for an unknown id or another channel's.
 */
export function createCancelUploadHandler(
  deps: CancelUploadDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    cancel: (input, userId) => cancelUpload(input, userId),
  }
) {
  return async function POST(_request: Request, { params }: { params: Promise<{ channelId: string; uploadId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, uploadId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json({ cancelled: true, ...(await deps.cancel({ channelId, uploadId }, userId)) });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createCancelUploadHandler();
