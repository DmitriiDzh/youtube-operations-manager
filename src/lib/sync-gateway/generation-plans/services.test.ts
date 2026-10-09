import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationPlansShareCore, GENERATION_PLANS_REPORT_FORMAT, type GenerationPlansReport } from "./index";

// AC-GP2-02 (GENERATION_PLANS_PHASE_2_PLAN.md): the merge rules of a per-device report family, as for media-sessions (ADR 0028).

function memoryStore() {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return { readLocal: async () => local, writeLocal: async (j: string) => void (local = j), readPeers: async () => ({ ...peers }), writePeer: async (id: string, j: string) => void (peers[id] = j) };
}

const report = (deviceId: string, updatedAt: string, over: Partial<GenerationPlansReport> = {}): GenerationPlansReport => ({ format: GENERATION_PLANS_REPORT_FORMAT, version: 1, deviceId, hostname: "win-pc", updatedAt, plans: [], verdicts: [], ...over });
const bytes = (r: unknown) => new TextEncoder().encode(JSON.stringify(r));
const NOW = new Date("2026-10-07T12:00:00Z");

function core() {
  return createGenerationPlansShareCore({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => NOW } });
}

test("AC-GP2-02: own report ignored; newer replaces older; older not accepted; future-dated and invalid refused with a reason; 7-day-silent peers dropped", async () => {
  const c = core();
  assert.deepEqual(await c.mergeIncoming(bytes(report("mac", "2026-10-07T11:00:00Z"))), { accepted: false });
  assert.deepEqual(await c.mergeIncoming(bytes(report("win", "2026-10-07T11:00:00Z"))), { accepted: true });
  assert.deepEqual(await c.mergeIncoming(bytes(report("win", "2026-10-07T10:00:00Z"))), { accepted: false });
  assert.deepEqual(await c.mergeIncoming(bytes(report("win", "2026-10-07T11:30:00Z", { hostname: "newer" }))), { accepted: true });
  assert.equal((await c.listPeerReports())[0].hostname, "newer");
  await assert.rejects(c.mergeIncoming(bytes(report("win", "2026-10-07T12:30:00Z"))), /in the future/);
  // BL-157 (SERVERS_MEDIA_PLAN.md §B): this build reads versions 1 and 2. BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2) adds version 3,
  // so the first version it cannot read is now 4.
  await assert.rejects(c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:40:00Z"), version: 4 })), /version 4 is newer/);
  await assert.rejects(c.mergeIncoming(new TextEncoder().encode("{")), /unreadable JSON/);
  // A verdict naming an absolute or escaping job output path is not a valid report.
  const bad = report("win", "2026-10-07T11:45:00Z", {
    plans: [{ planId: "p", title: "t", channelId: "UC", owner: "factory", status: "active", budget: { usd: null, gpuMinutes: null }, note: null, createdAt: "", updatedAt: "", closedAt: null, stages: [], groups: [], items: [], itemParams: {}, references: [], progress: {}, events: [], review: [{ itemKey: "a", groupId: null, attemptRef: "job:1", jobId: "1", seed: null, params: {}, stages: [], verdict: null, playable: true, jobOutput: "media/../../etc/passwd" }] }],
  });
  await assert.rejects(c.mergeIncoming(bytes(bad)), /invalid generation plans report/);
  const old = core();
  await old.mergeIncoming(bytes(report("gone", "2026-09-29T11:00:00Z")));
  assert.deepEqual(await old.listPeerReports(), [], "silent for more than 7 days");
});

test("AC-GP2-01 (transport part): only this device's report can be published, and it is what is exported", async () => {
  const c = core();
  await assert.rejects(c.publishLocalReport(report("win", "2026-10-07T11:00:00Z")), /only be published for this device/);
  await assert.rejects(c.exportBytes(), /No generation plans report/);
  await c.publishLocalReport(report("mac", "2026-10-07T11:00:00Z"));
  assert.equal(JSON.parse(new TextDecoder().decode(await c.exportBytes())).deviceId, "mac");
});

test("phase 2 review: a report in one device's file claiming to be another device's is refused (no impersonation)", async () => {
  const c = core();
  await assert.rejects(c.mergeIncoming(bytes(report("win", "2026-10-07T11:00:00Z")), "linux"), /claims to be from win/);
  assert.deepEqual(await c.mergeIncoming(bytes(report("win", "2026-10-07T11:00:00Z")), "win"), { accepted: true });
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-RP-01): version 2 adds optional fields; a version 1 report still reads as before.
const v2Plan = {
  planId: "R-0001-S1-music",
  title: "t",
  channelId: "UC_japan",
  owner: "factory" as const,
  status: "active" as const,
  budget: { usd: null, gpuMinutes: null },
  note: null,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
  closedAt: null,
  stages: [],
  groups: [{ groupId: "C14", title: "C14 new instruments", dependsOn: null, note: "LM planner off", ownerNote: "too bright" }],
  items: [],
  itemParams: {},
  references: [],
  progress: {},
  events: [],
  review: [
    {
      itemKey: "C14/F1",
      groupId: "C14",
      attemptRef: "job:j1",
      jobId: "j1",
      seed: null,
      params: {},
      stages: [],
      verdict: null,
      playable: true,
      jobOutput: "media/j1/out.mp3",
      jobChannelId: "UC_tropico",
      history: [{ result: "accepted" as const, rating: 8, note: null, device: "Mac-mini", at: "2026-10-07T10:30:00Z" }],
    },
  ],
  batches: [{ groupId: "C14", title: "C14 new instruments", note: "LM planner off", ownerNote: "too bright", firstAt: "2026-10-07T09:00:00Z", templates: ["ACE-Step 1.5"], differingParams: [{ name: "instruments", values: ["koto", "shamisen"] }], validator: { passed: 3, rejected: 9 } }],
};
const claim = { claimId: "claim-0001", planId: "R-0001-S1-music", ownerDeviceId: "mac", scope: "group" as const, itemKey: null, attemptRef: null, groupId: "C14", since: "2026-10-07T11:00:00Z", until: "2026-10-07T11:10:00Z" };

test("AC-RP-01: a version 2 report with the job channel, history, waves, the owner's wave note and claims is read; a version 1 report still is", async () => {
  const c = core();
  assert.deepEqual(await c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:00:00Z"), version: 2, plans: [v2Plan], claims: [claim] })), { accepted: true });
  const [read] = await c.listPeerReports();
  assert.equal(read.version, 2);
  assert.equal(read.plans[0].review[0].jobChannelId, "UC_tropico");
  assert.equal(read.plans[0].batches?.[0].validator.rejected, 9);
  assert.equal(read.claims?.[0].groupId, "C14");
  const { batches: _b, ...v1Plan } = v2Plan;
  void _b;
  const v1 = { ...v1Plan, groups: [{ groupId: "C14", title: "C14", dependsOn: null, note: null }], review: v2Plan.review.map(({ jobChannelId: _j, history: _h, ...entry }) => (void _j, void _h, entry)) };
  const other = core();
  assert.deepEqual(await other.mergeIncoming(bytes(report("win", "2026-10-07T11:00:00Z", { plans: [v1] }))), { accepted: true }, "version 1 without the new fields");
  const [old] = await other.listPeerReports();
  assert.equal(old.plans[0].review[0].jobChannelId, undefined);
  assert.equal(old.claims, undefined);
});

test("AC-RP-01: version 2 stays strict -- an unknown field or a claim with an unknown scope is refused", async () => {
  const c = core();
  await assert.rejects(c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:00:00Z"), version: 2, plans: [v2Plan], claims: [{ ...claim, scope: "plan" }] })), /invalid generation plans report/);
  await assert.rejects(c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:00:00Z"), version: 2, plans: [{ ...v2Plan, review: [{ ...v2Plan.review[0], extra: 1 }] }] })), /invalid generation plans report/);
});

// BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2, AC-NOTE-09): version 3 adds the wave notes sent to other devices and each wave's
// ownerNoteAt; versions 1 and 2 still read; version 3 stays strict.
test("AC-NOTE-09: a version 3 report with wave notes and ownerNoteAt is read; strict as before", async () => {
  const c = core();
  const note = { noteId: "note-0001", planId: "R-0001-S1-music", ownerDeviceId: "mac", groupId: "C14", note: "too bright", at: "2026-10-07T11:05:00Z" };
  const v3Plan = { ...v2Plan, groups: [{ ...v2Plan.groups[0], ownerNoteAt: "2026-10-07T11:04:00Z" }] };
  assert.deepEqual(await c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:10:00Z"), version: 3, plans: [v3Plan], claims: [claim], groupNotes: [note] })), { accepted: true });
  const [read] = await c.listPeerReports();
  assert.equal(read.version, 3);
  assert.deepEqual(read.groupNotes, [note]);
  assert.equal(read.plans[0].groups[0].ownerNoteAt, "2026-10-07T11:04:00Z");
  // A cleared note (null) is a note too; an unknown field in a wave note is refused.
  const other = core();
  assert.deepEqual(await other.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:10:00Z"), version: 3, groupNotes: [{ ...note, note: null }] })), { accepted: true });
  await assert.rejects(core().mergeIncoming(bytes({ ...report("win", "2026-10-07T11:10:00Z"), version: 3, groupNotes: [{ ...note, extra: 1 }] })), /invalid generation plans report/);
});
