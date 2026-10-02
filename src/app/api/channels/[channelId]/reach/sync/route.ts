import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createReachReportsCore } from "@/lib/reach-reports";
import { DomainError } from "@/lib/reach-reports/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createReachReportsCore();

// BL-114 (ADR 0014) -- makes sure the channel's Reporting job exists and imports every new report file.
// A real local-state mutation (writes channel_reach_daily) that also creates the Reporting job on first
// run, so it is gated by src/proxy.ts's blanket mutation check like any other POST. Body: `{ onlyIfDue?:
// boolean }` -- the dashboard's automatic call sets it so Google is hit at most every 6 hours per channel;
// the manual "Sync now" omits it. No `assertActiveChannel` here: the service does it itself, before any
// credential use.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;

    let onlyIfDue = false;
    try {
      const body = (await request.json()) as { onlyIfDue?: unknown };
      onlyIfDue = body?.onlyIfDue === true;
    } catch {
      // No/invalid body is a plain manual sync.
    }

    const result = await core.syncReachReports({
      credentialRef: { userId: session.user.id },
      channelId,
      ...(onlyIfDue ? { onlyIfDue: true } : {}),
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
