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
  await assert.rejects(c.mergeIncoming(bytes({ ...report("win", "2026-10-07T11:40:00Z"), version: 2 })), /version 2 is newer/);
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
