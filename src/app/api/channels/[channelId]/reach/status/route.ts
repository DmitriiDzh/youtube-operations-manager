import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getReportingReadsEnabled } from "@/lib/db";
import { createReachReportsCore } from "@/lib/reach-reports";
import { DomainError } from "@/lib/reach-reports/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createReachReportsCore();

// BL-114 -- the Reporting job and its report files for the Analytics card's status block (job, expected
// first file, last sync attempt and its error, imported files). A LOCAL read: no Google call, works while
// "Reporting reads" is off, and says whether it is off (`readsEnabled`) so the card can explain why a sync
// will not run. Never gated by src/proxy.ts's mutation check (GET).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const status = await core.getReachStatus({ credentialRef: { userId: session.user.id }, channelId });
    return NextResponse.json({ ...status, readsEnabled: await getReportingReadsEnabled() });
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
