import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { DomainError } from "@/lib/ai-localization/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiLocalizationCore();
const channelAccess = createChannelAccessCore();

// Phase 6, Slice 1: "inspect and edit proposals" -> "create Change Set" step. Persists
// a ChangeSet (source "ai_localization") via the EXISTING, UNMODIFIED changesets
// creation path (AGENTS.md §D) -- everything after this point (approve/reject, Batch
// creation, dry-run preview) reuses the Phase 4/5 routes already in this API surface
// unchanged; there is no separate approval/batch endpoint for AI-sourced changes.
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

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "validation_failed", message: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    const changeSet = await core.createChangeSetFromGeneration({ ...body, channelId });
    return NextResponse.json({ changeSet }, { status: 201 });
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
