import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { createChangeSetCore } from "@/lib/changesets";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { getLiveWritesEnabled } from "@/lib/db";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { createRealExperimentExecutionResolver } from "@/app/api/decision-engine/experiment-execution-resolver";

const core = createDecisionEngineCore();
const executionResolver = createRealExperimentExecutionResolver({
  changeSetCore: createChangeSetCore(),
  batchCore: createBatchCore(),
});

// Body: { live?: boolean } -- creates a real Batch from the experiment's attached Change Set's
// eligible approved changes (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §1/§4). Fail-closed,
// identical to `/api/channels/[channelId]/batches`' own gate (AGENTS.md §G): `live: true` in the
// body is only ever honored when the Settings-tab Live Writes toggle is already on -- with the
// toggle off, the resulting Batch is unconditionally dry-run regardless of what the body asks for.
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
    const liveWritesEnabled = await getLiveWritesEnabled();
    const result = await core.executeExperiment(
      experimentId,
      body,
      { userId: session.user.id },
      executionResolver,
      liveWritesEnabled
    );
    return NextResponse.json(result, { status: 201 });
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
