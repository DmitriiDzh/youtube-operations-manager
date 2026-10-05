import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiConnectionsCatalogCoreForProduction, DomainError, isDomainError, type AiConnectionFieldConflict } from "@/lib/sync-gateway";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiConnectionsCatalogCoreForProduction();

/**
 * Every currently-unresolved AI-connections `FieldConflict` -- read-only, device-wide (like
 * `.../change-drafts/conflicts-summary`), never per-channel: `ai_connections` has no
 * `channel_id` at all (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Category B).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let conflicts: AiConnectionFieldConflict[];
    try {
      conflicts = await core.listConflicts();
    } catch (error) {
      // No global document saved yet -- zero conflicts, not an error.
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
 * Resolves one AI-connection field conflict by choosing which device's competing value wins
 * (`ai-connections-catalog/services.ts`'s `resolveConflict`). A real mutation, gated by
 * `src/proxy.ts`'s device-availability lock like any other write.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    const { connectionId, field, winningActorId } = (body ?? {}) as {
      connectionId?: unknown;
      field?: unknown;
      winningActorId?: unknown;
    };
    if (typeof connectionId !== "string" || typeof field !== "string" || typeof winningActorId !== "string") {
      return NextResponse.json(
        { error: "validation_failed", message: "connectionId, field, and winningActorId are required strings" },
        { status: 400 }
      );
    }

    const connection = await core.resolveConflict({
      connectionId,
      field: field as AiConnectionFieldConflict["field"],
      winningActorId,
    });
    return NextResponse.json({ connection });
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
