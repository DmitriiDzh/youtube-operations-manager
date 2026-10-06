import { test } from "node:test";
import assert from "node:assert/strict";
import { createApproveResearchRequestHandler, type ApproveResearchRequestDeps } from "./route";

// BL-145 (P4, owner 2026-10-07): an approved agent search's candidates become visible to the channel that asked.
function setup(opts: { status: string; candidateIds?: string[]; owners?: string[]; existing?: Record<string, string[]>; failFor?: string }) {
  const writes: Array<{ recordId: string; channelIds: string[] }> = [];
  const assignments = {
    async listAssignments(input: unknown) {
      const kind = (input as { recordKind: string }).recordKind;
      if (kind === "research_request") return opts.owners ? [{ recordKind: kind, recordId: "req-1", channelIds: opts.owners }] : [];
      return Object.entries(opts.existing ?? {}).map(([recordId, channelIds]) => ({ recordKind: kind, recordId, channelIds }));
    },
    async setAssignment(input: unknown) {
      const i = input as { recordId: string; channelIds: string[] };
      if (i.recordId === opts.failFor) throw new Error("not connected");
      writes.push({ recordId: i.recordId, channelIds: [...i.channelIds].sort() });
      return { recordKind: "discovery_candidate", recordId: i.recordId, channelIds: i.channelIds };
    },
  } as unknown as ApproveResearchRequestDeps["assignments"];
  const core = {
    approveMarketResearchRequest: async () => ({ requestId: "req-1", status: opts.status, candidateIds: opts.candidateIds }),
  } as unknown as ApproveResearchRequestDeps["core"];
  const handler = createApproveResearchRequestHandler({ getSession: async () => ({ user: { id: "u" } }), core, assignments });
  const call = () => handler(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ requestId: "req-1" }) });
  return { writes, call };
}

test("BL-145: found candidates are shared with the request's channel, added to what they already had", async () => {
  const { writes, call } = setup({ status: "executed", candidateIds: ["UCa", "UCb", "UCc"], owners: ["UCmine"], existing: { UCb: ["UCother"], UCc: ["UCmine"] } });
  const res = await call();
  assert.equal(res.status, 200);
  assert.deepEqual(writes, [
    { recordId: "UCa", channelIds: ["UCmine"] },
    { recordId: "UCb", channelIds: ["UCmine", "UCother"] },
  ]);
});

test("BL-145: nothing is shared for a request with no owner channel, a failed run, or a candidate that cannot be assigned", async () => {
  assert.deepEqual((await (async () => { const s = setup({ status: "executed", candidateIds: ["UCa"] }); await s.call(); return s.writes; })()), []);
  assert.deepEqual((await (async () => { const s = setup({ status: "execution_failed", owners: ["UCmine"] }); await s.call(); return s.writes; })()), []);
  const s = setup({ status: "executed", candidateIds: ["UCa", "UCb"], owners: ["UCmine"], failFor: "UCa" });
  const res = await s.call();
  assert.equal(res.status, 200, "a sharing failure never fails the approval");
  assert.deepEqual(s.writes, [{ recordId: "UCb", channelIds: ["UCmine"] }]);
});

test("BL-145: the approve route needs a session", async () => {
  const s = createApproveResearchRequestHandler({
    getSession: async () => null,
    core: {} as ApproveResearchRequestDeps["core"],
    assignments: {} as ApproveResearchRequestDeps["assignments"],
  });
  const res = await s(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ requestId: "r" }) });
  assert.equal(res.status, 401);
});
