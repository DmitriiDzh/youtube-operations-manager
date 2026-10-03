import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { createLiveWriteExecutorIfEnabled } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createBatchCore();
const channelAccess = createChannelAccessCore();

/**
 * The one route in this API surface that can perform a real `videos.update` call (owner
 * instruction, 2026-09-21 -- the Settings-tab live-writes toggle). Only reachable for a batch
 * created with `dryRun: false` (the sibling `POST .../batches` route only allows that when the
 * same toggle is on) -- a dry-run batch's ledger rows are already terminal at
 * `DRY_RUN_COMPLETE` and this call would simply do nothing for them, never a write.
 *
 * `createLiveWriteExecutorIfEnabled` is Layer 1 of the two-layer barrier: if the toggle is off
 * at this exact moment, it returns `null` and this route refuses BEFORE `executeBatch` (which
 * itself still independently re-checks the same setting as Layer 2, inside the executor,
 * immediately before any network call) is ever invoked.
 */
export async function POST(
  request: Request,
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

    const credentialRef = { userId: session.user.id };
    const executor = await createLiveWriteExecutorIfEnabled(credentialRef);
    if (!executor) {
      return NextResponse.json(
        {
          error: "live_writes_disabled",
          message: "Real YouTube writes are off -- turn on \"Live writes\" in Settings first.",
        },
        { status: 409 }
      );
    }

    // BL-117: the pre-flight quota guard refuses a live batch that needs more quota than is left, or (when Cloud is not
    // connected) cannot be checked. `acknowledgeUnknownQuota` is the user's explicit "run anyway" for the second case only.
    let acknowledgeUnknownQuota = false;
    try {
      const body = (await request.json()) as { acknowledgeUnknownQuota?: unknown };
      acknowledgeUnknownQuota = body?.acknowledgeUnknownQuota === true;
    } catch {
      // No/invalid body: a plain execute.
    }

    const summary = await core.executeBatch({
      batchId,
      credentialRef,
      expectedChannelId: channelId,
      executor,
      acknowledgeUnknownQuota,
    });

    return NextResponse.json(summary);
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
