import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChangeDraftsCoreForProduction, DomainError, isDomainError, type FieldConflict } from "@/lib/change-drafts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeDraftsCoreForProduction();
const channelAccess = createChannelAccessCore();

/**
 * Every currently-unresolved `FieldConflict` for one channel (AUTOMERGE_MIGRATION_PLAN.md §6
 * CD6) -- read-only. Scoped to the caller's active channel like every other per-channel route
 * (docs/DEVELOPMENT_PLAYBOOK.md §6.6(b)), unlike the device-wide sync/summary routes, since this
 * one DOES take `channelId` from the client (a URL path parameter).
 */
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
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    let conflicts: FieldConflict[];
    try {
      conflicts = await core.listConflicts({ channelId });
    } catch (error) {
      // No draft document for this channel yet -- zero conflicts, not an error.
      if (isDomainError(error) && error.code === "not_found") {
        conflicts = [];
      } else {
        throw error;
      }
    }

    return NextResponse.json({ conflicts });
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
