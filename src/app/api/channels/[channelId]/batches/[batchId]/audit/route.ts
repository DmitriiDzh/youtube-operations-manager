import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAuditCore } from "@/lib/audit";
import { createBatchCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const batchCore = createBatchCore();
const auditCore = createAuditCore();
const channelAccess = createChannelAccessCore();

/** Audit + recovery visibility for a batch: the full per-video event sequence
 * (PREPARATION/ATTEMPT/RESULT/CONFLICT/VERIFICATION/DRY_RUN/RECONCILIATION), reused
 * unchanged from src/lib/audit/ -- no parallel audit-reading logic here. */
export async function GET(
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
    await batchCore.requireBatchForChannel(channelId, batchId);

    const events = await auditCore.listForBatch(batchId);
    return NextResponse.json({ events });
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
