import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md): the owner removes a video from an experiment's arms.
const core = createDecisionEngineCore();

export async function DELETE(request: Request, { params }: { params: Promise<{ experimentId: string; videoId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { experimentId, videoId } = await params;
    return NextResponse.json(await core.unlinkExperimentArmVideo(experimentId, videoId, { userId: session.user.id }));
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
