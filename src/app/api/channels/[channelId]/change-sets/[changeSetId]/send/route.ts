import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createSendApprovedCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createSendApprovedCore();
const channelAccess = createChannelAccessCore();

/**
 * BL-124 / ADR 0020 -- the one-click "send approved changes" button's server half. It only SELECTS the
 * change set's sendable changes and CREATES a live batch from them; it never writes. The browser then runs
 * the existing `batches/[batchId]/execute` route (its own Live-writes Layer 1/2 checks, quota guard,
 * identity check, backups, pre-write conflict check, verification all unchanged) and polls the batch for
 * the progress pop-up.
 *
 * With Live writes off the service refuses FIRST with `live_writes_disabled` and creates nothing, so a disabled
 * toggle never leaves a batch behind (unlike `POST .../batches`, which silently downgrades to a dry run).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; changeSetId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, changeSetId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    const result = await core.createLiveBatchForChangeSet({ channelId, changeSetId });
    return NextResponse.json(
      { batchId: result.batch.id, changeCount: result.changeCount, videoCount: result.videoCount, batch: result.batch },
      { status: 201 }
    );
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
}
