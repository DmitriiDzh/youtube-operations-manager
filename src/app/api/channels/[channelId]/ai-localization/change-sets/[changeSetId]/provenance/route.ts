import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { DomainError } from "@/lib/ai-localization/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiLocalizationCore();

// Phase 6, Channel Editorial Profiles: read-only lookup of which profile version /
// effective context produced a given Change Set's proposals -- frozen at generation
// time, unaffected by later profile edits (AC-PROFILE-08). Channel-scoped
// (AC-PROFILE-09): a provenance row belonging to a different channel is treated as
// not found (returns `{ provenance: null }`, not another channel's data).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; changeSetId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, changeSetId } = await params;
    const provenance = await core.getGenerationProvenance({ channelId, changeSetId });
    return NextResponse.json({ provenance });
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
