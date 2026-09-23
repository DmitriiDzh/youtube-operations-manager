import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createEditorialProfileCoreForProduction, DomainError, isDomainError, type EditorialProfileFieldConflict } from "@/lib/sync-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createEditorialProfileCoreForProduction();
const channelAccess = createChannelAccessCore();

/**
 * Every currently-unresolved editorial-profile `FieldConflict` for one channel -- read-only.
 * Mirrors `.../change-drafts/conflicts`'s own route exactly (`docs/roadmap/plans/
 * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` M3's editorial-profile family gained the same
 * conflict-listing/resolution capability as change-drafts already had, 2026-09-23).
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

    let conflicts: EditorialProfileFieldConflict[];
    try {
      conflicts = await core.listConflicts(channelId);
    } catch (error) {
      // No editorial-profile document for this channel yet -- zero conflicts, not an error.
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

/**
 * Resolves one editorial-profile field conflict by choosing which device's competing value wins
 * (`editorial-profile/services.ts`'s `resolveConflict` -- the winning value is re-derived
 * server-side from `winningActorId`, never trusted as a raw client-supplied string). A real
 * mutation, gated by `src/proxy.ts`'s device-availability lock like any other write.
 */
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
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    const body: unknown = await request.json();
    const { field, winningActorId } = (body ?? {}) as { field?: unknown; winningActorId?: unknown };
    if (typeof field !== "string" || typeof winningActorId !== "string") {
      return NextResponse.json(
        { error: "validation_failed", message: "field and winningActorId are required strings" },
        { status: 400 }
      );
    }

    const profile = await core.resolveConflict({
      channelId,
      field: field as EditorialProfileFieldConflict["field"],
      winningActorId,
    });
    return NextResponse.json({ profile });
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
