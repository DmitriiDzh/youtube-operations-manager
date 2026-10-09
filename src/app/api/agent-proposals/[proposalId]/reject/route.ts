import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentProposalReviewCore } from "@/lib/agent-proposals";
import { errorResponse, unauthorized, type SessionLike } from "../../shared";

export type RejectAgentProposalDeps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createAgentProposalReviewCore>, "rejectAgentProposal">;
};

// BL-163 (FO-REQ-0014 §C7): the owner rejects a proposal with a required comment `{ comment }` -- the reason, for the agent.
// Web UI only, like the approve route; nothing else changes.
export function createRejectAgentProposalHandler(deps: RejectAgentProposalDeps = { getSession: () => getServerSession(authOptions), core: createAgentProposalReviewCore() }) {
  return async function POST(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    try {
      const { proposalId } = await params;
      const comment = body && typeof body === "object" ? (body as { comment?: unknown }).comment : undefined;
      return NextResponse.json({ proposal: await deps.core.rejectAgentProposal({ proposalId, comment }, { userId: session.user.id }) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const POST = createRejectAgentProposalHandler();
