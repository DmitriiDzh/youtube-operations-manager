import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createBatchCore();

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
    // AGENTS.md §F / docs/DEVELOPMENT_PLAYBOOK.md §6.6: channel-context validation is
    // not automatic -- requireBatchForChannel verifies this batch actually belongs to
    // the channel named in the URL before returning anything about it.
    const batch = await core.requireBatchForChannel(channelId, batchId);
    const ledgerRows = await core.listLedgerRows(batchId);

    return NextResponse.json({ batch, ledgerRows });
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
