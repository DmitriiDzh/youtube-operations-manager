import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md): the videos of an experiment's arms -- read, and linked by the owner.
const core = createDecisionEngineCore();

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

export async function GET(request: Request, { params }: { params: Promise<{ experimentId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { experimentId } = await params;
    return NextResponse.json(await core.listExperimentArms(experimentId, { userId: session.user.id }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ experimentId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    const { experimentId } = await params;
    const result = await core.linkExperimentArmVideo(experimentId, body, { userId: session.user.id, linkedBy: session.user.id, linkedVia: "web_ui" });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
