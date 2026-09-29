import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { createChangeSetCore } from "@/lib/changesets";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError, type ExperimentExecutionResolver } from "@/lib/decision-engine/contracts";
import { getLiveWritesEnabled } from "@/lib/db";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { createRealExperimentExecutionResolver } from "@/app/api/decision-engine/experiment-execution-resolver";

type ExecuteRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createDecisionEngineCore>, "executeExperiment">;
  resolver: ExperimentExecutionResolver;
  getLiveWritesEnabled: () => Promise<boolean>;
};

const defaultDeps: ExecuteRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createDecisionEngineCore(),
  resolver: createRealExperimentExecutionResolver({
    changeSetCore: createChangeSetCore(),
    batchCore: createBatchCore(),
  }),
  getLiveWritesEnabled,
};

// Body: { live?: boolean } -- creates a real Batch from the experiment's attached Change Set's
// eligible approved changes (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §1/§4). Fail-closed,
// identical to `/api/channels/[channelId]/batches`' own gate (AGENTS.md §G): `live: true` in the
// body is only ever honored when the Settings-tab Live Writes toggle is already on -- with the
// toggle off, the resulting Batch is unconditionally dry-run regardless of what the body asks for.
// Injectable factory (matching `createOverviewGetHandler`'s own precedent, Phase 9 slice 9H part B)
// specifically so a route test can prove the real `getLiveWritesEnabled()` value is what actually
// reaches the service, not just that the service's own boolean-in/boolean-out logic works
// (`advisor()` review, round 2 -- the fail-closed gate had no test proving the route itself wires
// the real toggle read, only that the service honored whatever boolean it was handed by hand).
export function createExecuteExperimentHandler(deps: ExecuteRouteDeps = defaultDeps) {
  return async function POST(request: Request, { params }: { params: Promise<{ experimentId: string }> }) {
    const session = await deps.getSession();
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
      const liveWritesEnabled = await deps.getLiveWritesEnabled();
      const result = await deps.core.executeExperiment(experimentId, body, { userId: session.user.id }, deps.resolver, liveWritesEnabled);
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
  };
}

export const POST = createExecuteExperimentHandler();
