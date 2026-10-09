import assert from "node:assert/strict";
import test from "node:test";
import { describeProposalAction, type OwnerProposalView } from "./agent-proposals-model";

// BL-163 (FO-REQ-0014 §C7: "what will change, in plain words"): one text per kind, written from the plan's kind list (§2.C).

const base: OwnerProposalView = {
  proposalId: "p1",
  source: "producer",
  kind: "watchlist.pause",
  channelId: "UC_ours_1",
  targetId: "UCaaaaaaaaaaaaaaaaaaaaaa",
  payload: { researchChannelId: "UCaaaaaaaaaaaaaaaaaaaaaa" },
  text: "x",
  status: "pending",
  createdAt: "2026-10-09T12:00:00.000Z",
  decidedAt: null,
  rejectComment: null,
  applyError: null,
  doneAt: null,
  channelTitle: "Rural Japan",
  targetLabel: "@alpha",
};

test("each kind says what approving it changes, naming the competitor and our channel", () => {
  const of = (patch: Partial<OwnerProposalView>) => describeProposalAction({ ...base, ...patch });
  assert.deepEqual(of({}), { key: "agentProposals.action.pause", values: {}, subject: "@alpha" });
  assert.deepEqual(of({ kind: "watchlist.resume" }), { key: "agentProposals.action.resume", values: {}, subject: "@alpha" });
  assert.deepEqual(of({ kind: "watchlist.delete", source: "system", channelId: null, channelTitle: null }), { key: "agentProposals.action.delete", values: {}, subject: "@alpha" });
  assert.deepEqual(of({ kind: "watchlist.unfollow" }), { key: "agentProposals.action.unfollow", values: { channel: "Rural Japan" }, subject: "@alpha" });
  // An entry already on the watchlist is followed; a new one is added (its handle, else its id, names it).
  assert.deepEqual(of({ kind: "watchlist.add" }), { key: "agentProposals.action.follow", values: { channel: "Rural Japan" }, subject: "@alpha" });
  assert.deepEqual(of({ kind: "watchlist.add", targetLabel: null, payload: { competitorChannelId: "UCgg", handleOrUrl: "@gamma", reason: "r" } }), {
    key: "agentProposals.action.add",
    values: { channel: "Rural Japan" },
    subject: "@gamma",
  });
  assert.deepEqual(of({ kind: "watchlist.add", targetLabel: null, targetId: "UCgg", payload: { competitorChannelId: "UCgg", reason: "r" } }).subject, "UCgg");
  assert.deepEqual(of({ kind: "hypothesis.add", targetId: null, targetLabel: null, payload: { statement: "Rain lifts retention", evidenceNotes: "e" } }), {
    key: "agentProposals.action.hypothesis",
    values: { channel: "Rural Japan" },
    subject: "Rain lifts retention",
  });
  // A disconnected channel is named by its id rather than left blank.
  assert.deepEqual(of({ kind: "watchlist.unfollow", channelTitle: null }).values, { channel: "UC_ours_1" });
  assert.equal(of({ kind: "watchlist.rename" }).key, "agentProposals.action.unknown");
});
