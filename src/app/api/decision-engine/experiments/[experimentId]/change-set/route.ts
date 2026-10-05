import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { createChangeSetCore } from "@/lib/changesets";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { createRealExperimentExecutionResolver } from "@/app/api/decision-engine/experiment-execution-resolver";

const core = createDecisionEngineCore();
const executionResolver = createRealExperimentExecutionResolver({
  changeSetCore: createChangeSetCore(),
  batchCore: createBatchCore(),
});

// Body: { changeSetId: string | null } -- attach or detach the Change Set this experiment will
// execute (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §4/§5). Only ever legal in "proposed" or
// "approved" -- a running/concluded/abandoned experiment's Change Set link is immutable.
export async function PUT(request: Request, { params }: { params: Promise<{ experimentId: string }> }) {
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
    const experiment = await core.setExperimentChangeSet(experimentId, body, { userId: session.user.id }, executionResolver);
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
