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
 * Runs the batch's dry-run preview pipeline (identity check, fresh per-video fetch,
 * merge/diff, backup) -- never a real write, since every batch reaching this route was
 * created with `dryRun: true` forced at creation (see the parent route). There is no
 * corresponding "execute live" route anywhere in this API surface: the live-execution
 * service function is never called from src/app/api/** (enforced by
 * src/lib/batches/write-path-inventory.test.ts).
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

    const result = await core.prepareBatchExecution({
      batchId,
      credentialRef: { userId: session.user.id },
      expectedChannelId: channelId,
    });

    return NextResponse.json(result);
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
