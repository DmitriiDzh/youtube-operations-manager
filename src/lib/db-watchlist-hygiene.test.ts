import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  claimStaleResearchChannelsForCollection,
  decideAgentProposal,
  deleteResearchChannel,
  getResearchChannelById,
  initializeDatabaseSchema,
  insertAgentProposal,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  listAgentProposals,
  listLatestUploadDates,
  listResearchChannels,
  markAgentProposalsDone,
  pauseInactiveResearchChannel,
  purgeAgentProposals,
  setRecordAssignmentChannels,
  setResearchChannelPause,
  type AppDb,
  type NewAgentProposal,
} from "@/lib/db";
import { createMarketIntelligenceServices } from "@/lib/market-intelligence/services";

// BL-163 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §3): the watchlist pause, the inactivity detector and the proposal
// store against a real throwaway libSQL database. Expected values are worked out by hand from the plan's rules (N = 6 months,
// "now" 2026-10-09 12:00 UTC, so the cutoff is 2026-04-09 12:00 UTC), not read off the implementation.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const A = "UCaaaaaaaaaaaaaaaaaaaaaa"; // newest upload 2026-03-09 (7 months) -> inactive
const B = "UCbbbbbbbbbbbbbbbbbbbbbb"; // newest upload 2026-05-09 (5 months) -> active
const C = "UCcccccccccccccccccccccc"; // no snapshots -> unknown -> never inactive

async function freshDb(): Promise<{ db: AppDb; db2: AppDb }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-watchlist-hygiene-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const a = createLibsqlClient({ url });
  await initializeDatabaseSchema(a);
  return { db: drizzle(a) as unknown as AppDb, db2: drizzle(createLibsqlClient({ url })) as unknown as AppDb };
}

async function seed(db: AppDb): Promise<void> {
  for (const id of [A, B, C]) await insertResearchChannel({ id, handleOrUrl: `@${id.slice(2, 5)}`, reason: "competitor", createdVia: "web_ui" }, db);
  let n = 0;
  const video = (researchChannelId: string, publishedAt: string) =>
    insertMarketVideoSnapshot({ id: `snap-${++n}`, researchChannelId, videoId: `vid${n}`, publishedAt: new Date(publishedAt), source: "youtube.videos.list", createdVia: "web_ui" }, db);
  await video(A, "2026-02-09T10:00:00.000Z");
  await video(A, "2026-03-09T10:00:00.000Z");
  await video(B, "2026-05-09T10:00:00.000Z");
}

/** The detector through the real service, its store bound to `db`. */
function detector(db: AppDb, ids: { next: number }) {
  return createMarketIntelligenceServices({
    idGenerator: () => `proposal-${++ids.next}`,
    clock: { now: () => NOW },
    listResearchChannels: () => listResearchChannels(db),
    getResearchChannelById: (id: string) => getResearchChannelById(id, db),
    listLatestUploadDates: () => listLatestUploadDates(db),
    getMarketIntelligenceInactiveAfterMonths: async () => 6,
    pauseInactiveResearchChannel: (args: Parameters<typeof pauseInactiveResearchChannel>[0]) => pauseInactiveResearchChannel(args, db),
    setResearchChannelPause: (id: string, pause: Parameters<typeof setResearchChannelPause>[1], at?: Date) => setResearchChannelPause(id, pause, at, db),
  } as unknown as Parameters<typeof createMarketIntelligenceServices>[0]);
}

const claimable = (db: AppDb, only?: string[]) =>
  claimStaleResearchChannelsForCollection({ now: NOW, staleCutoff: NOW, claimExpiryCutoff: NOW, excludeResearchChannelIds: [], ...(only ? { onlyResearchChannelIds: only } : {}) }, db).then((ids) => ids.sort());

test("AC-WH-01/02: the detector pauses only the entry whose known newest upload is older than 6 months, with one deletion proposal naming the date", async () => {
  const { db } = await freshDb();
  await seed(db);
  const ids = { next: 0 };
  const svc = detector(db, ids);
  const list = await svc.listWatchlist();
  const byId = Object.fromEntries(list.channels.map((c) => [c.channelId, c]));
  assert.deepEqual([byId[A].latestUploadPublishedAt, byId[A].inactive], ["2026-03-09T10:00:00.000Z", true]);
  assert.deepEqual([byId[B].latestUploadPublishedAt, byId[B].inactive], ["2026-05-09T10:00:00.000Z", false]);
  assert.deepEqual([byId[C].latestUploadPublishedAt, byId[C].inactive], [null, false], "unknown is never inactive");

  assert.deepEqual(await svc.evaluateWatchlistInactivity(), { paused: [A] });
  const after = Object.fromEntries((await svc.listWatchlist()).channels.map((c) => [c.channelId, c]));
  assert.deepEqual([after[A].pausedAt, after[A].pausedReason], [NOW.toISOString(), "inactive"]);
  assert.equal(after[B].pausedAt, null);
  const proposals = await listAgentProposals({}, db);
  assert.equal(proposals.length, 1);
  assert.deepEqual([proposals[0].source, proposals[0].kind, proposals[0].targetId, proposals[0].status, proposals[0].dedupeKey], ["system", "watchlist.delete", A, "pending", `watchlist.delete|${A}`]);
  assert.match(proposals[0].text, /2026-03-09/);
  // A second run changes nothing (AC-WH-02).
  assert.deepEqual(await svc.evaluateWatchlistInactivity(), { paused: [] });
  assert.equal((await listAgentProposals({}, db)).length, 1);
});

test("AC-WH-02: a second process evaluating after the first adds nothing; the pending key is unique across connections", async () => {
  // Two computers each run on their own database; the one place two writers meet a pending key is the same database reached from
  // two connections (the web server and the CLI) -- sequentially, as libSQL serialises writers.
  const { db, db2 } = await freshDb();
  await seed(db);
  const ids = { next: 0 };
  assert.deepEqual(await detector(db, ids).evaluateWatchlistInactivity(), { paused: [A] });
  assert.deepEqual(await detector(db2, ids).evaluateWatchlistInactivity(), { paused: [] });
  const [only] = await listAgentProposals({}, db);
  const again = await insertAgentProposal({ ...only, id: "proposal-other-connection", status: undefined } as unknown as NewAgentProposal, db2);
  assert.deepEqual([again.created, again.proposal.id], [false, only.id]);
  assert.equal((await listAgentProposals({}, db)).length, 1);
});

test("AC-WH-03: a paused entry is never claimed for collection -- automatically or by an approved request", async () => {
  const { db } = await freshDb();
  await seed(db);
  await setResearchChannelPause(A, { at: NOW, reason: "owner" }, NOW, db);
  assert.deepEqual(await claimable(db), [B, C].sort());
  assert.deepEqual(await claimable(db, [A]), [], "an approved collection request naming it collects nothing");
});

test("AC-WH-04/07: a pause stays until the owner resumes; a resumed entry is not paused again for the same silence", async () => {
  const { db } = await freshDb();
  await seed(db);
  const svc = detector(db, { next: 0 });
  await svc.evaluateWatchlistInactivity();
  // Rejecting its deletion proposal does not resume it (AC-WH-07).
  const [proposal] = await listAgentProposals({}, db);
  await decideAgentProposal(proposal.id, { status: "rejected", at: NOW, by: "owner", rejectComment: "keep it for now" }, db);
  assert.equal((await getResearchChannelById(A, db))?.pausedReason, "inactive");
  // The owner resumes it: collected again, and not paused again for the same silence (AC-WH-04).
  await svc.setWatchlistPause({ channelId: A, paused: false });
  assert.equal((await getResearchChannelById(A, db))?.pausedAt, null);
  assert.deepEqual(await claimable(db), [A, B, C].sort());
  assert.deepEqual(await svc.evaluateWatchlistInactivity(), { paused: [] });
  // A newer upload after the resume that goes quiet again does count: newest 2026-04-01 (after the resume is not possible
  // before NOW in this fixture), so simulate the order with a resume stamped before that upload.
  await setResearchChannelPause(A, null, new Date("2026-03-20T00:00:00.000Z"), db);
  await insertMarketVideoSnapshot({ id: "snap-late", researchChannelId: A, videoId: "late", publishedAt: new Date("2026-04-01T00:00:00.000Z"), source: "youtube.videos.list", createdVia: "web_ui" }, db);
  assert.deepEqual(await svc.evaluateWatchlistInactivity(), { paused: [A] });
});

test("AC-WH-05: delete completely also drops the entry's links to our channels and its pending proposals; decided ones stay", async () => {
  const { db } = await freshDb();
  await seed(db);
  await setRecordAssignmentChannels("research_channel", A, ["UC_ours_1", "UC_ours_2"], db);
  await setRecordAssignmentChannels("research_channel", B, ["UC_ours_1"], db);
  const proposal = (id: string, kind: string, status: "pending" | "rejected"): NewAgentProposal => ({
    id,
    source: "producer",
    kind,
    channelId: "UC_ours_1",
    targetId: A,
    payloadJson: "{}",
    text: "x",
    dedupeKey: status === "pending" ? `${kind}|${A}` : null,
    createdVia: "mcp",
    agentApiVersion: null,
    createdAt: NOW,
  });
  await insertAgentProposal(proposal("p-pending", "watchlist.pause", "pending"), db);
  await insertAgentProposal(proposal("p-decided", "watchlist.unfollow", "pending"), db);
  await decideAgentProposal("p-decided", { status: "rejected", at: NOW, by: "owner", rejectComment: "no" }, db);
  await deleteResearchChannel(A, db);
  assert.equal(await getResearchChannelById(A, db), null);
  const left = await listAgentProposals({}, db);
  assert.deepEqual(left.map((p) => p.id), ["p-decided"]);
  // B's link is untouched; A's links are gone.
  const { listRecordAssignmentChannels } = await import("@/lib/db");
  assert.deepEqual(await listRecordAssignmentChannels("research_channel", A, db), []);
  assert.deepEqual(await listRecordAssignmentChannels("research_channel", B, db), ["UC_ours_1"]);
});

test("AC-PR-02/03/06: the proposal store -- one pending per key, an atomic decision, done only once decided, purge after 90 days or done", async () => {
  const { db } = await freshDb();
  const base: NewAgentProposal = { id: "p1", source: "producer", kind: "watchlist.pause", channelId: "UC_ours_1", targetId: A, payloadJson: "{}", text: "pause it", dedupeKey: `watchlist.pause|${A}`, createdVia: "mcp", agentApiVersion: "1.1.0", createdAt: NOW };
  assert.equal((await insertAgentProposal(base, db)).created, true);
  const dup = await insertAgentProposal({ ...base, id: "p2" }, db);
  assert.deepEqual([dup.created, dup.proposal.id], [false, "p1"], "a second pending one for the same key is not created");
  assert.deepEqual(await markAgentProposalsDone(["p1"], NOW, { source: "producer" }, db), [], "a pending one cannot be marked done");
  assert.equal((await decideAgentProposal("p1", { status: "applied", at: NOW, by: "owner" }, db))?.status, "applied");
  assert.equal(await decideAgentProposal("p1", { status: "rejected", at: NOW, by: "owner", rejectComment: "late" }, db), null, "decided once");
  // The key is free again once decided.
  assert.equal((await insertAgentProposal({ ...base, id: "p3" }, db)).created, true);
  // Purge: p1 decided now -> kept at +89 days, purged at +91; p3 pending -> never.
  const day = 24 * 60 * 60 * 1000;
  assert.equal(await purgeAgentProposals(new Date(NOW.getTime() + 89 * day), 90 * day, db), 0);
  assert.equal(await purgeAgentProposals(new Date(NOW.getTime() + 91 * day), 90 * day, db), 1);
  assert.deepEqual((await listAgentProposals({}, db)).map((p) => p.id), ["p3"]);
  // Marked done: purged at once.
  await decideAgentProposal("p3", { status: "rejected", at: NOW, by: "owner", rejectComment: "no" }, db);
  assert.deepEqual(await markAgentProposalsDone(["p3"], NOW, { source: "producer" }, db), ["p3"]);
  assert.equal(await purgeAgentProposals(NOW, 90 * day, db), 1);
});
