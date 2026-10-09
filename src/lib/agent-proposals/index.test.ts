import assert from "node:assert/strict";
import test from "node:test";
import {
  addChannelRecordAssignment,
  getResearchChannelById,
  insertResearchChannel,
  listHypotheses,
  listRecordAssignmentChannels,
  setSelectedChannelId,
  upsertChannel,
  upsertUserOAuthOnSignIn,
} from "@/lib/db";
import { createAgentProposalReviewCore, createAgentProposalSubmitCore } from "./index";

// BL-163 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.C "Apply ... through the same services the UI uses"): the real
// wiring, end to end, on this test process's isolated database -- the Producer's core submits, the owner's core approves, and the
// change lands in the real watchlist, links and hypotheses. Expected rows are stated by hand from each proposal.

const OWNER = "bl163-owner";
const OURS = "UC_bl163_ours";
const COMPETITOR = "UCpppppppppppppppppppppp";
const NEW_COMPETITOR = "UCqqqqqqqqqqqqqqqqqqqqqq";
const V = { agentApiVersion: "1.1.0" };

test("real wiring: pause, add, hypothesis and delete are made only on approval, through the real modules", async () => {
  await upsertUserOAuthOnSignIn({ userId: OWNER, name: "Owner", email: "owner@example.com", image: null, accessToken: null, refreshToken: null, tokenExpiry: null, scope: null });
  await upsertChannel({ channelId: OURS, title: "Rural Japan", thumbnailUrl: null, uploadsPlaylistId: `UU${OURS}`, connectedUserId: OWNER });
  await insertResearchChannel({ id: COMPETITOR, handleOrUrl: "@competitor", reason: "competitor", createdVia: "web_ui" });
  await addChannelRecordAssignment(OURS, "research_channel", COMPETITOR);
  const producer = createAgentProposalSubmitCore();
  const owner = createAgentProposalReviewCore();
  const submit = (kind: string, payload: Record<string, unknown>) => producer.submitProducerProposal({ channelId: OURS, kind, text: "because", payload }, V);
  const approve = (proposalId: string) => owner.approveAgentProposal({ proposalId }, { userId: OWNER });

  // Pause: nothing before approval; on approval the entry is paused by the owner.
  const pause = await submit("watchlist.pause", { researchChannelId: COMPETITOR });
  assert.equal((await getResearchChannelById(COMPETITOR))?.pausedAt, null);
  assert.equal((await owner.listOwnerProposals({ view: "pending" })).proposals[0].targetLabel, "@competitor");
  const paused = await approve(pause.proposalId);
  assert.equal(paused.status, "applied", paused.applyError ?? "");
  assert.equal((await getResearchChannelById(COMPETITOR))?.pausedReason, "owner");

  // Add a new competitor: on the watchlist (created via mcp, its reason) and followed by our channel.
  const add = await submit("watchlist.add", { competitorChannelId: NEW_COMPETITOR, reason: "same niche", handleOrUrl: "@new" });
  assert.equal(await getResearchChannelById(NEW_COMPETITOR), null);
  assert.equal((await approve(add.proposalId)).status, "applied");
  const added = await getResearchChannelById(NEW_COMPETITOR);
  assert.deepEqual([added?.reason, added?.handleOrUrl, added?.createdVia], ["same niche", "@new", "mcp"]);
  assert.deepEqual(await listRecordAssignmentChannels("research_channel", NEW_COMPETITOR), [OURS]);

  // A hypothesis waits while another channel (none) is active, then is created as the Producer's.
  const hypothesis = await submit("hypothesis.add", { statement: "Rain sounds lift retention", evidenceNotes: "3 of 4 rain uploads" });
  await assert.rejects(approve(hypothesis.proposalId), (error: { code?: string }) => error.code === "AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE");
  await setSelectedChannelId(OWNER, OURS);
  assert.equal((await approve(hypothesis.proposalId)).status, "applied");
  const created = (await listHypotheses()).filter((h) => h.statement === "Rain sounds lift retention");
  assert.deepEqual(created.map((h) => [h.channelId, h.evidenceNotes, h.createdBy, h.createdVia]), [[OURS, "3 of 4 rain uploads", "producer", "mcp"]]);

  // Delete completely: the entry and its links are gone; the applied proposal stays for the Producer to read.
  const del = await submit("watchlist.delete", { researchChannelId: NEW_COMPETITOR });
  assert.equal((await approve(del.proposalId)).status, "applied");
  assert.equal(await getResearchChannelById(NEW_COMPETITOR), null);
  assert.deepEqual(await listRecordAssignmentChannels("research_channel", NEW_COMPETITOR), []);
  const statuses = (await producer.listProducerProposals({})).proposals.map((p) => [p.kind, p.status]);
  assert.deepEqual(statuses.sort(), [
    ["hypothesis.add", "applied"],
    ["watchlist.add", "applied"],
    ["watchlist.delete", "applied"],
    ["watchlist.pause", "applied"],
  ]);
});
