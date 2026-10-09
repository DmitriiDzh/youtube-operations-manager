import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentProposalReviewCore } from "@/lib/agent-proposals";
import { errorResponse, unauthorized, type SessionLike } from "./shared";

export type AgentProposalsListDeps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createAgentProposalReviewCore>, "listOwnerProposals">;
};

// BL-163 (FO-REQ-0014 §C7): the owner's list of agent proposals -- `?view=pending` (default) or `decided` (still in the store).
export function createAgentProposalsListHandler(deps: AgentProposalsListDeps = { getSession: () => getServerSession(authOptions), core: createAgentProposalReviewCore() }) {
  return async function GET(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    try {
      const view = new URL(request.url).searchParams.get("view") ?? "pending";
      return NextResponse.json(await deps.core.listOwnerProposals({ view }));
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createAgentProposalsListHandler();
