import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createBatchCore();
const channelAccess = createChannelAccessCore();

/**
 * Cooperative cancel of a batch that is executing right now (ADR 0016): rows that have not started
 * end CANCELLED, a row already writing finishes and is verified, the batch ends ABORTED. This route
 * never writes to YouTube. `accepted: false` means nothing was executing in this process (already
 * finished, never started, or the server restarted) -- not an error.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; batchId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, batchId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    await core.requireBatchForChannel(channelId, batchId);
    return NextResponse.json(await core.requestBatchCancel(batchId));
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
