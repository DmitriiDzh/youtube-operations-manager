import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { DomainError } from "@/lib/ai-localization/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiLocalizationCore();

// Phase 6, Slice 1: "generate localization proposals" + "validate output" steps of the
// AI Localization workflow. Read-only with respect to persistence -- generates
// proposals for review, never creates a Change/ChangeSet itself (see the
// change-sets/route.ts sibling for that step). Never calls a real, paid AI provider
// (docs/acceptance/PHASE_6_ACCEPTANCE.md AC-PROVIDER-01/AC-COST-01) and never touches
// the YouTube API.
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

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "validation_failed", message: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    const result = await core.generateProposals({ ...body, channelId });
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
