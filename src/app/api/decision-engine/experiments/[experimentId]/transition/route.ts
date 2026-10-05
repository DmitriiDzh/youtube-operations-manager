import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createDecisionEngineCore();

// Body: { targetStatus: "proposed" | "approved" | "running" | "concluded" | "abandoned" }.
// `approvedBy` is server-stamped from the session when targetStatus is "approved" -- never
// accepted from the request body (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §4).
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
    const experiment = await core.transitionExperiment(experimentId, body, {
      userId: session.user.id,
      actor: session.user.id,
    });
    return NextResponse.json({ experiment });
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
