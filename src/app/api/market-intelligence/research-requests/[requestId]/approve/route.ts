import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketAssignmentCore } from "@/lib/market-assignments";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type Assignments = Pick<ReturnType<typeof createMarketAssignmentCore>, "listAssignments" | "setAssignment">;

export type ApproveResearchRequestDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "approveMarketResearchRequest">;
  assignments: Assignments;
};

/**
 * BL-145 (P4, owner 2026-10-07): the candidates an approved agent search produced become visible to the channel(s)
 * that own the request (normally the requesting agent's channel), added to whatever they were already assigned to.
 * Best effort per candidate: a failure to share never undoes the approval or the search.
 */
async function shareWithRequestOwners(assignments: Assignments, owners: string[], candidateIds: string[]): Promise<void> {
  if (owners.length === 0 || candidateIds.length === 0) return;
  const current = new Map((await assignments.listAssignments({ recordKind: "discovery_candidate" })).map((a) => [a.recordId, a.channelIds]));
  for (const candidateId of new Set(candidateIds)) {
    const before = current.get(candidateId) ?? [];
    const after = [...new Set([...before, ...owners])];
    if (after.length === before.length) continue;
    try {
      await assignments.setAssignment({ recordKind: "discovery_candidate", recordId: candidateId, channelIds: after });
    } catch {
      // e.g. an owner channel disconnected since: the candidate stays as it was; the operator can assign it by hand.
    }
  }
}

// Phase 9 slice 9G, part B (owner spec §29) -- the ONLY way a research request can move out of
// "pending" into "approved" (see docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §2/§7): a
// human, through this Web-UI-only route, using their own resolved session credentials for the one
// real search.list call this triggers. No MCP tool or CLI command anywhere in this codebase calls
// the underlying action -- verified mechanically by this module's own approval inventory test. A
// real mutation, gated by src/proxy.ts like any other.
export function createApproveResearchRequestHandler(
  deps: ApproveResearchRequestDeps = {
    getSession: () => getServerSession(authOptions),
    core: createMarketIntelligenceCore(),
    assignments: createMarketAssignmentCore(),
  }
) {
  return async function POST(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { requestId } = await params;
      // Read before the approval: who asked (the request's own channel assignment, recorded when the agent created it).
      let owners: string[] = [];
      try {
        owners = (await deps.assignments.listAssignments({ recordKind: "research_request" })).find((a) => a.recordId === requestId)?.channelIds ?? [];
      } catch {
        // Sharing is best effort; the approval itself goes on.
      }
      const result = await deps.core.approveMarketResearchRequest({ requestId, credentialRef: { userId: session.user.id } }, { createdVia: "web_ui" });
      if (result.status === "executed" && result.candidateIds) {
        try {
          await shareWithRequestOwners(deps.assignments, owners, result.candidateIds);
        } catch {
          // Best effort, see above.
        }
      }
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
  };
}

export const POST = createApproveResearchRequestHandler();
