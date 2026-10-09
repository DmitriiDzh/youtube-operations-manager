import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createAgentProposalsListHandler } from "./route";
import { createApproveAgentProposalHandler } from "./[proposalId]/approve/route";
import { createRejectAgentProposalHandler } from "./[proposalId]/reject/route";

// BL-163 (FO-REQ-0014 §C7): the owner's three routes -- session-gated; the id comes from the path, the decider from the session.

const owner = async () => ({ user: { id: "owner-1" } });
const nobody = async () => null;
const params = (proposalId = "p1") => ({ params: Promise.resolve({ proposalId }) });
const post = (body: unknown) => new Request("http://localhost/api/agent-proposals/p1/reject", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("list route: the view is forwarded (pending by default); unauthenticated is 401", async () => {
  const views: unknown[] = [];
  const core = {
    async listOwnerProposals(input: unknown) {
      views.push(input);
      return { proposals: [], pendingCount: 0 };
    },
  };
  assert.equal((await createAgentProposalsListHandler({ getSession: owner, core })(new Request("http://localhost/api/agent-proposals"))).status, 200);
  await createAgentProposalsListHandler({ getSession: owner, core })(new Request("http://localhost/api/agent-proposals?view=decided"));
  assert.equal((await createAgentProposalsListHandler({ getSession: nobody, core })(new Request("http://localhost/api/agent-proposals"))).status, 401);
  assert.deepEqual(views, [{ view: "pending" }, { view: "decided" }]);
});

test("approve route: decides as the session's user; NOT_PENDING is 409; unauthenticated never reaches the core", async () => {
  const seen: unknown[] = [];
  const core = {
    async approveAgentProposal(input: unknown, ctx: { userId: string }) {
      seen.push([input, ctx]);
      if ((input as { proposalId: string }).proposalId === "done") throw new DomainError({ code: "AGENT_PROPOSAL_NOT_PENDING", message: "decided" });
      return { proposalId: "p1", status: "applied" } as never;
    },
  };
  const ok = await createApproveAgentProposalHandler({ getSession: owner, core })(new Request("http://localhost", { method: "POST" }), params());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { proposal: { proposalId: "p1", status: "applied" } });
  const late = await createApproveAgentProposalHandler({ getSession: owner, core })(new Request("http://localhost", { method: "POST" }), params("done"));
  assert.equal(late.status, 409);
  assert.equal((await createApproveAgentProposalHandler({ getSession: nobody, core })(new Request("http://localhost", { method: "POST" }), params())).status, 401);
  assert.deepEqual(seen, [
    [{ proposalId: "p1" }, { userId: "owner-1" }],
    [{ proposalId: "done" }, { userId: "owner-1" }],
  ]);
});

test("reject route: forwards the comment; a missing comment comes back 400 from the core's validation; invalid JSON is 400", async () => {
  const seen: unknown[] = [];
  const core = {
    async rejectAgentProposal(input: unknown, ctx: { userId: string }) {
      seen.push([input, ctx]);
      const comment = (input as { comment?: unknown }).comment;
      if (typeof comment !== "string" || comment.trim() === "") throw new DomainError({ code: "validation_failed", message: "a comment is required" });
      return { proposalId: "p1", status: "rejected", rejectComment: comment } as never;
    },
  };
  const handler = createRejectAgentProposalHandler({ getSession: owner, core });
  const ok = await handler(post({ comment: "Not our niche" }), params());
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).proposal.rejectComment, "Not our niche");
  assert.equal((await handler(post({}), params())).status, 400);
  assert.equal((await handler(post("not json"), params())).status, 400);
  assert.equal((await createRejectAgentProposalHandler({ getSession: nobody, core })(post({ comment: "x" }), params())).status, 401);
  assert.deepEqual(seen, [
    [{ proposalId: "p1", comment: "Not our niche" }, { userId: "owner-1" }],
    [{ proposalId: "p1", comment: undefined }, { userId: "owner-1" }],
  ]);
});
