import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  countPendingAgentProposals,
  decideAgentProposal,
  deleteResearchChannel,
  failAgentProposal,
  getAgentProposal,
  initializeDatabaseSchema,
  insertAgentProposal,
  insertResearchChannel,
  listAgentProposals,
  markAgentProposalsDone,
  purgeAgentProposals,
  reopenAgentProposal,
  type AppDb,
} from "@/lib/db";
import { createAgentProposalServices, type AgentProposalStore, type StoredProposal, type WatchlistPort } from "./services";

// BL-163 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §3, AC-PR-01..07). The proposal store is the real one on a
// throwaway libSQL database; the watchlist and the hypotheses are recording fakes, so each test states by hand which change the
// owner's approval must make, and that nothing changes before it.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const OURS_1 = "UC_ours_1";
const OURS_2 = "UC_ours_2";
const A = "UCaaaaaaaaaaaaaaaaaaaaaa"; // followed by both, active
const B = "UCbbbbbbbbbbbbbbbbbbbbbb"; // followed by OURS_2 only, paused
const C = "UCcccccccccccccccccccccc"; // not on the watchlist
const OWNER = "owner-user";

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-proposals-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

function storeOn(db: AppDb): AgentProposalStore {
  return {
    insert: async (row) => (await insertAgentProposal(row, db)) as { proposal: StoredProposal; created: boolean },
    get: async (id) => (await getAgentProposal(id, db)) as StoredProposal | null,
    list: async (filter) => (await listAgentProposals(filter, db)) as StoredProposal[],
    decide: async (id, decision) => (await decideAgentProposal(id, decision, db)) as StoredProposal | null,
    fail: (id, error) => failAgentProposal(id, error, db),
    markDone: (ids, at, filter) => markAgentProposalsDone(ids, at, filter, db),
    purge: (now, keepMs) => purgeAgentProposals(now, keepMs, db),
    countPending: () => countPendingAgentProposals(db),
    reopen: (id) => reopenAgentProposal(id, db),
  };
}

type Entry = { followers: string[]; pausedAt: string | null; handleOrUrl: string | null };

async function setup(
  options: { activeChannel?: string | null; onRemove?: (id: string) => Promise<void>; hypothesisError?: () => Error | null; connected?: string[] } = {}
) {
  const db = await freshDb();
  const entries = new Map<string, Entry>([
    [A, { followers: [OURS_1, OURS_2], pausedAt: null, handleOrUrl: "@alpha" }],
    [B, { followers: [OURS_2], pausedAt: "2026-10-01T00:00:00.000Z", handleOrUrl: null }],
  ]);
  const calls: string[] = [];
  const watchlist: WatchlistPort = {
    getEntry: async (id) => {
      const entry = entries.get(id);
      return entry ? { channelId: id, handleOrUrl: entry.handleOrUrl, pausedAt: entry.pausedAt } : null;
    },
    followers: async (id) => [...(entries.get(id)?.followers ?? [])],
    add: async (input) => {
      calls.push(`add ${input.channelId} reason=${input.reason}${input.handleOrUrl ? ` handle=${input.handleOrUrl}` : ""}`);
      entries.set(input.channelId, { followers: [], pausedAt: null, handleOrUrl: input.handleOrUrl ?? null });
    },
    setFollowers: async (id, channelIds) => {
      calls.push(`followers ${id} = ${channelIds.join(",")}`);
      entries.get(id)!.followers = channelIds;
    },
    setPause: async (id, paused) => {
      calls.push(`${paused ? "pause" : "resume"} ${id}`);
      entries.get(id)!.pausedAt = paused ? NOW.toISOString() : null;
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      if (options.onRemove) await options.onRemove(id);
      entries.delete(id);
    },
    describe: async () => new Map([...entries].map(([id, entry]) => [id, { label: entry.handleOrUrl ?? id, latestUploadPublishedAt: id === A ? "2026-03-09T10:00:00.000Z" : null }])),
  };
  let next = 0;
  const services = createAgentProposalServices({
    idGenerator: () => `p${++next}`,
    clock: { now: () => NOW },
    store: storeOn(db),
    watchlist,
    hypotheses: {
      add: async (input, ctx) => {
        const failure = options.hypothesisError?.();
        if (failure) throw failure;
        calls.push(`hypothesis ${input.channelId} "${input.statement}" / "${input.evidenceNotes}" by ${ctx.userId}`);
      },
      activeChannelOf: async () => (options.activeChannel === undefined ? OURS_1 : options.activeChannel),
    },
    listConnectedChannels: async () =>
      [
        { channelId: OURS_1, title: "Rural Japan" },
        { channelId: OURS_2, title: "Tropico" },
      ].filter((channel) => (options.connected ?? [OURS_1, OURS_2]).includes(channel.channelId)),
    assertDeviceAvailable: async () => {},
  });
  return { db, services, calls, entries };
}

const propose = (kind: string, payload: Record<string, unknown>, channelId = OURS_1, text = "because the evidence says so") => ({ channelId, kind, text, payload });

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: { code?: string }) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("AC-PR-01: a Producer proposal is stored pending with its text; nothing in the watchlist or the hypotheses changes", async () => {
  const { services, calls } = await setup();
  const pause = await services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }, OURS_1, "No upload since 2023-11-29"), { agentApiVersion: "1.1.0" });
  assert.deepEqual(
    [pause.source, pause.kind, pause.channelId, pause.targetId, pause.status, pause.text, pause.payload],
    ["producer", "watchlist.pause", OURS_1, A, "pending", "No upload since 2023-11-29", { researchChannelId: A }]
  );
  const hypothesis = await services.submitProducerProposal(propose("hypothesis.add", { statement: "Rain sounds lift retention", evidenceNotes: "3 of 4 rain uploads" }), { agentApiVersion: "1.1.0" });
  assert.deepEqual([hypothesis.kind, hypothesis.targetId, hypothesis.status], ["hypothesis.add", null, "pending"]);
  await services.submitProducerProposal(propose("watchlist.add", { competitorChannelId: C, reason: "same niche", handleOrUrl: "@gamma" }), { agentApiVersion: "1.1.0" });
  assert.deepEqual(calls, [], "no change before approval");
});

test("AC-PR-04: an unknown or unfollowed entry, an unconnected channel, a bad payload and a duplicate pending proposal are refused at submit", async () => {
  const { db, services } = await setup();
  const v = { agentApiVersion: "1.1.0" };
  await rejectsWith(services.submitProducerProposal(propose("watchlist.delete", { researchChannelId: C }), v), "RESEARCH_CHANNEL_NOT_AVAILABLE");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.delete", { researchChannelId: B }, OURS_1), v), "RESEARCH_CHANNEL_NOT_AVAILABLE");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.delete", { researchChannelId: A }, "UC_not_connected"), v), "CHANNEL_NOT_ACTIVE");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.add", { competitorChannelId: "@gamma", reason: "x" }), v), "validation_failed");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A, extra: 1 }), v), "validation_failed");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }, OURS_1, "   "), v), "validation_failed");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.add", { competitorChannelId: A, reason: "x" }, OURS_1), v), "AGENT_PROPOSAL_NOT_APPLICABLE");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: B }, OURS_2), v), "AGENT_PROPOSAL_NOT_APPLICABLE");
  await rejectsWith(services.submitProducerProposal(propose("watchlist.resume", { researchChannelId: A }), v), "AGENT_PROPOSAL_NOT_APPLICABLE");
  // One pending pause per entry, whichever of our channels proposes it.
  await services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }, OURS_1), v);
  await rejectsWith(services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }, OURS_2), v), "AGENT_PROPOSAL_DUPLICATE");
  // Unfollowing is per channel: OURS_2 may propose its own while OURS_1's waits.
  await services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_1), v);
  await rejectsWith(services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_1), v), "AGENT_PROPOSAL_DUPLICATE");
  await services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_2), v);
  // A delete shares its key with the system's own deletion proposal.
  await insertAgentProposal(
    { id: "sys-1", source: "system", kind: "watchlist.delete", channelId: null, targetId: B, payloadJson: "{}", text: "No upload since 2026-03-09", dedupeKey: `watchlist.delete|${B}`, createdVia: "system", agentApiVersion: null, createdAt: NOW },
    db
  );
  await rejectsWith(services.submitProducerProposal(propose("watchlist.delete", { researchChannelId: B }, OURS_2), v), "AGENT_PROPOSAL_DUPLICATE");
  // Two different hypotheses are two proposals.
  await services.submitProducerProposal(propose("hypothesis.add", { statement: "one", evidenceNotes: "e" }), v);
  await services.submitProducerProposal(propose("hypothesis.add", { statement: "one", evidenceNotes: "e" }), v);
  assert.equal((await listAgentProposals({ status: "pending" }, db)).length, 6);
});

test("AC-PR-02: approve applies the change once (a second approve is NOT_PENDING); reject needs a comment and changes nothing", async () => {
  const { services, calls } = await setup();
  const v = { agentApiVersion: "1.1.0" };
  const pause = await services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }), v);
  const approved = await services.approveAgentProposal({ proposalId: pause.proposalId }, { userId: OWNER });
  assert.deepEqual([approved.status, approved.decidedBy, approved.decidedAt, approved.applyError], ["applied", OWNER, NOW.toISOString(), null]);
  await rejectsWith(services.approveAgentProposal({ proposalId: pause.proposalId }, { userId: OWNER }), "AGENT_PROPOSAL_NOT_PENDING");
  await rejectsWith(services.rejectAgentProposal({ proposalId: pause.proposalId, comment: "late" }, { userId: OWNER }), "AGENT_PROPOSAL_NOT_PENDING");
  await rejectsWith(services.approveAgentProposal({ proposalId: "nope" }, { userId: OWNER }), "AGENT_PROPOSAL_NOT_FOUND");
  assert.deepEqual(calls, [`pause ${A}`]);

  const unfollow = await services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_2), v);
  await rejectsWith(services.rejectAgentProposal({ proposalId: unfollow.proposalId }, { userId: OWNER }), "validation_failed");
  await rejectsWith(services.rejectAgentProposal({ proposalId: unfollow.proposalId, comment: "   " }, { userId: OWNER }), "validation_failed");
  const rejected = await services.rejectAgentProposal({ proposalId: unfollow.proposalId, comment: "Tropico still borrows its thumbnails" }, { userId: OWNER });
  assert.deepEqual([rejected.status, rejected.rejectComment, rejected.decidedBy], ["rejected", "Tropico still borrows its thumbnails", OWNER]);
  assert.deepEqual(calls, [`pause ${A}`], "a rejection changes nothing");
});

test("Apply: each kind makes exactly its own change through the watchlist and hypotheses services", async () => {
  const { services, calls, entries } = await setup();
  const v = { agentApiVersion: "1.1.0" };
  const approve = async (kind: string, payload: Record<string, unknown>, channelId = OURS_1) => {
    const p = await services.submitProducerProposal(propose(kind, payload, channelId), v);
    const result = await services.approveAgentProposal({ proposalId: p.proposalId }, { userId: OWNER });
    assert.equal(result.status, "applied", `${kind}: ${result.applyError}`);
  };
  await approve("watchlist.add", { competitorChannelId: C, reason: "same niche", handleOrUrl: "@gamma" });
  await approve("watchlist.add", { competitorChannelId: B, reason: "Rural Japan should watch it too" });
  await approve("watchlist.unfollow", { researchChannelId: A }, OURS_2);
  await approve("watchlist.resume", { researchChannelId: B }, OURS_2);
  await approve("watchlist.delete", { researchChannelId: C });
  await approve("hypothesis.add", { statement: "Rain sounds lift retention", evidenceNotes: "3 of 4 rain uploads" });
  assert.deepEqual(calls, [
    `add ${C} reason=same niche handle=@gamma`,
    `followers ${C} = ${OURS_1}`,
    `followers ${B} = ${OURS_2},${OURS_1}`,
    `followers ${A} = ${OURS_1}`,
    `resume ${B}`,
    `remove ${C}`,
    `hypothesis ${OURS_1} "Rain sounds lift retention" / "3 of 4 rain uploads" by ${OWNER}`,
  ]);
  assert.equal(entries.has(C), false);
});

test("Apply: a hypothesis waits (stays pending) while the owner's active channel is another one", async () => {
  const { services, calls } = await setup({ activeChannel: OURS_2 });
  const p = await services.submitProducerProposal(propose("hypothesis.add", { statement: "s", evidenceNotes: "e" }, OURS_1), { agentApiVersion: "1.1.0" });
  await rejectsWith(services.approveAgentProposal({ proposalId: p.proposalId }, { userId: OWNER }), "AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE");
  const { proposals } = await services.listProducerProposals({});
  assert.deepEqual(proposals.map((x) => x.status), ["pending"]);
  assert.deepEqual(calls, []);
});

test("AC-PR-07: a change that cannot be made is stored failed with the error and never retried", async () => {
  const { services, entries, calls } = await setup();
  const p = await services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }), { agentApiVersion: "1.1.0" });
  entries.delete(A); // deleted meanwhile (outside this store, so its proposal is still pending)
  const result = await services.approveAgentProposal({ proposalId: p.proposalId }, { userId: OWNER });
  assert.equal(result.status, "failed");
  assert.match(result.applyError ?? "", /RESEARCH_CHANNEL_NOT_AVAILABLE/);
  await rejectsWith(services.approveAgentProposal({ proposalId: p.proposalId }, { userId: OWNER }), "AGENT_PROPOSAL_NOT_PENDING");
  assert.deepEqual(calls, []);
});

test("Approving a deletion: the entry's own pending proposals go with it, the one being applied stays (claimed first)", async () => {
  const holder: { db?: AppDb } = {};
  const env = await setup({ onRemove: (id) => deleteResearchChannel(id, holder.db!) });
  const db = (holder.db = env.db);
  await insertResearchChannel({ id: A, handleOrUrl: "@alpha", reason: "competitor", createdVia: "web_ui" }, db);
  const v = { agentApiVersion: "1.1.0" };
  const del = await env.services.submitProducerProposal(propose("watchlist.delete", { researchChannelId: A }), v);
  const other = await env.services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_2), v);
  const result = await env.services.approveAgentProposal({ proposalId: del.proposalId }, { userId: OWNER });
  assert.equal(result.status, "applied");
  assert.equal((await getAgentProposal(del.proposalId, db))?.status, "applied");
  assert.equal(await getAgentProposal(other.proposalId, db), null, "the entry's other pending proposal is gone with it");
});

test("A system deletion proposal is approved the same way; rejecting it leaves the entry as it is", async () => {
  const { db, services, calls } = await setup();
  const system = (id: string, target: string) =>
    insertAgentProposal(
      { id, source: "system", kind: "watchlist.delete", channelId: null, targetId: target, payloadJson: JSON.stringify({ researchChannelId: target }), text: "No upload since 2026-03-09", dedupeKey: `watchlist.delete|${target}`, createdVia: "system", agentApiVersion: null, createdAt: NOW },
      db
    );
  await system("sys-a", A);
  await system("sys-b", B);
  const owner = await services.listOwnerProposals({ view: "pending" });
  assert.equal(owner.pendingCount, 2);
  // The card names the entry and shows its current newest upload, read live from the watchlist (never stored on the proposal).
  assert.deepEqual(
    owner.proposals.map((p) => [p.proposalId, p.source, p.channelTitle, p.targetLabel, p.targetLatestUploadPublishedAt]).sort(),
    [
      ["sys-a", "system", null, "@alpha", "2026-03-09T10:00:00.000Z"],
      ["sys-b", "system", null, B, null],
    ]
  );
  assert.equal((await services.approveAgentProposal({ proposalId: "sys-a" }, { userId: OWNER })).status, "applied");
  assert.equal((await services.rejectAgentProposal({ proposalId: "sys-b", comment: "keep it for now" }, { userId: OWNER })).status, "rejected");
  assert.deepEqual(calls, [`remove ${A}`]);
  // The Producer's list holds only its own proposals.
  assert.deepEqual((await services.listProducerProposals({})).proposals, []);
});

test("AC-PR-03: the Producer reads the outcome and the comment; marking a decided one done removes it, a pending one cannot be marked", async () => {
  const { db, services } = await setup();
  const v = { agentApiVersion: "1.1.0" };
  const pending = await services.submitProducerProposal(propose("watchlist.pause", { researchChannelId: A }), v);
  const rejected = await services.submitProducerProposal(propose("watchlist.unfollow", { researchChannelId: A }, OURS_2), v);
  await services.rejectAgentProposal({ proposalId: rejected.proposalId, comment: "no" }, { userId: OWNER });
  const listed = (await services.listProducerProposals({})).proposals;
  assert.deepEqual(
    listed.map((p) => [p.proposalId, p.status, p.rejectComment]).sort(),
    [
      [pending.proposalId, "pending", null],
      [rejected.proposalId, "rejected", "no"],
    ].sort()
  );
  assert.deepEqual((await services.listProducerProposals({ status: "rejected", channelId: OURS_2 })).proposals.map((p) => p.proposalId), [rejected.proposalId]);
  assert.deepEqual(await services.markProducerProposalsDone({ proposalIds: [pending.proposalId, rejected.proposalId, "unknown"] }), {
    marked: [rejected.proposalId],
    notMarked: [pending.proposalId, "unknown"],
  });
  assert.equal(await getAgentProposal(rejected.proposalId, db), null, "marked done = left the store");
  assert.deepEqual((await services.listProducerProposals({})).proposals.map((p) => p.proposalId), [pending.proposalId]);
});

test("Approve: a watchlist.add whose channel is no longer connected waits (nothing is added); a channel switch mid-approval re-opens a hypothesis", async () => {
  const connected = [OURS_1, OURS_2];
  let switched = false;
  const { services, calls, db } = await setup({
    connected,
    hypothesisError: () => (switched ? Object.assign(new Error("not active"), { name: "DomainError", code: "CHANNEL_NOT_ACTIVE" }) : null),
  });
  const v = { agentApiVersion: "1.1.0" };
  const add = await services.submitProducerProposal(propose("watchlist.add", { competitorChannelId: C, reason: "r" }), v);
  connected.splice(connected.indexOf(OURS_1), 1);
  await rejectsWith(services.approveAgentProposal({ proposalId: add.proposalId }, { userId: OWNER }), "AGENT_PROPOSAL_NOT_APPLICABLE");
  assert.equal((await getAgentProposal(add.proposalId, db))?.status, "pending");
  assert.deepEqual(calls, []);

  connected.push(OURS_1);
  const hypothesis = await services.submitProducerProposal(propose("hypothesis.add", { statement: "s", evidenceNotes: "e" }), v);
  switched = true;
  await rejectsWith(services.approveAgentProposal({ proposalId: hypothesis.proposalId }, { userId: OWNER }), "AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE");
  const reopened = await getAgentProposal(hypothesis.proposalId, db);
  assert.deepEqual([reopened?.status, reopened?.decidedAt, reopened?.decidedBy], ["pending", null, null]);
  switched = false;
  assert.equal((await services.approveAgentProposal({ proposalId: hypothesis.proposalId }, { userId: OWNER })).status, "applied");
});

test("Reads delete nothing: a decided proposal past 90 days is not listed but stays until a gated write purges it", async () => {
  const { db, services } = await setup();
  await insertAgentProposal(
    { id: "old", source: "producer", kind: "watchlist.pause", channelId: OURS_1, targetId: A, payloadJson: "{}", text: "x", dedupeKey: null, createdVia: "mcp", agentApiVersion: "1.1.0", createdAt: new Date("2026-06-01T00:00:00.000Z") },
    db
  );
  await decideAgentProposal("old", { status: "rejected", at: new Date("2026-07-01T00:00:00.000Z"), by: OWNER, rejectComment: "no" }, db); // 100 days before NOW
  assert.deepEqual((await services.listProducerProposals({})).proposals, []);
  assert.deepEqual((await services.listOwnerProposals({ view: "decided" })).proposals, []);
  assert.notEqual(await getAgentProposal("old", db), null, "a read deleted nothing");
  await services.markProducerProposalsDone({ proposalIds: ["unknown"] });
  assert.equal(await getAgentProposal("old", db), null, "the gated write purged it");
  assert.equal(await services.countPendingProposals(), 0);
});
