import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 follow-up, slice 4 (docs/roadmap/FUTURE_PHASES.md §4, weekly reports). Called once per
// dashboard mount (src/app/dashboard/page.tsx), chained AFTER the auto-collect trigger resolves
// -- see src/lib/analytics/weekly-report.ts's own doc comment for the full trigger design. A real
// local-persistence mutation when (and only when) it decides a new/replacement snapshot is due,
// so this route is gated by src/proxy.ts like any other mutating POST.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const result = await core.runWeeklyReportIfDue({
      credentialRef: { userId: session.user.id },
      channelId,
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
