import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentProposalReviewCore } from "@/lib/agent-proposals";
import { errorResponse, unauthorized, type SessionLike } from "../../shared";

export type ApproveAgentProposalDeps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createAgentProposalReviewCore>, "approveAgentProposal">;
};

// BL-163 (FO-REQ-0014 §C7, spec §26): the ONLY way a proposal is approved and its change made -- a human, through this Web-UI
// route. No MCP tool, CLI command or agent-operations code reaches it (`agent-proposal-approval-inventory.test.ts`). The answer is
// the decided proposal: `applied`, or `failed` with the error when the change could not be made.
export function createApproveAgentProposalHandler(deps: ApproveAgentProposalDeps = { getSession: () => getServerSession(authOptions), core: createAgentProposalReviewCore() }) {
  return async function POST(_request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    try {
      const { proposalId } = await params;
      return NextResponse.json({ proposal: await deps.core.approveAgentProposal({ proposalId }, { userId: session.user.id }) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const POST = createApproveAgentProposalHandler();
