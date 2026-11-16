import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { decisionForRow } from "@/lib/publishing/plan-schedule";
import { agentSurface, createPublishingPlansService, ownerSurface } from "./services";
import { isDomainError, type PlanAuditEntry, type PlanProgressResult, type PlanSlotPackage, type PlanSlotProgress, type PlanView } from "./contracts";

// BL-256 acceptance (owner msgs 4380/4383; docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md "BL-256", AC-RT-01..10). The owner moves a
// slot to another day of its week and/or another time in the Web UI; with `approve` the new time is approved in the same step, and
// the uploads (plan-schedule) then date the uploaded video at the new time. Expected values by hand: Asia/Tokyo is UTC+9, so 15:00
// JST on Monday 2026-10-26 is 06:00Z, 17:30 JST that day 08:30Z, 20:00 JST on Tuesday 2026-10-27 11:00Z. The channel is in the
// default `packaged` stage. Hashes are SHA-256 of the literal JSON arrays ADR 0051/0062 name, computed here with node:crypto.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";
const AA = "a".repeat(64);
const sha = (fields: unknown[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

const pkg = (over: Partial<PlanSlotPackage> = {}): PlanSlotPackage => ({
  video: "V64",
  title: "Title V64",
  durationSeconds: 600,
  languages: ["ja"],
  containsSyntheticMedia: true,
  thumbnailPath: null,
  testThumbnails: 0,
  problems: [],
  manifestSha256: AA,
  ...over,
});

function harness() {
  const clock = { now: new Date("2026-10-25T07:00:00Z") };
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const audits: PlanAuditEntry[] = [];
  const progress = new Map<string, PlanSlotProgress>();
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (channelId) => channelId === CH,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    progress: async (_c, _w, ids): Promise<PlanProgressResult> => ({ progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: false }),
  });
  return { service, audits, progress, clock, owner: ownerSurface(service) };
}

const slot = (slotId: string, day: string, time: string) => ({ slotId, date: day, publishAt: `${day}T${time}`, lengthHint: "≈ 10 мин" });
const slotOf = (plan: PlanView, slotId: string) => plan.slots.find((s) => s.slotId === slotId)!;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const codeOf = (e: unknown) => (isDomainError(e) ? e.code : String(e));
const reasonsOf = (e: unknown) => (isDomainError(e) ? ((e.details as { refused?: Array<{ reason: string }> }).refused ?? []).map((r) => r.reason) : []);

async function setup(videoId: string | null = null) {
  const h = harness();
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [slot("s1", "2026-10-26", "15:00"), slot("s2", "2026-10-27", "18:00")] }, "factory");
  h.progress.set("s1", { status: videoId ? "scheduled" : "packaged", code: null, videoId, package: pkg() });
  return h;
}
const get = async (h: ReturnType<typeof harness>) => (await h.service.get({ channelId: CH, weekStart: WEEK })).plan;
async function approve(h: ReturnType<typeof harness>, slotId: string) {
  return h.owner.decide(CH, WEEK, { action: "approve", slots: [{ slotId, contentHash: slotOf(await get(h), slotId).contentHash }] }, "u1");
}
async function retime(h: ReturnType<typeof harness>, slotId: string, date: string, time: string, approveToo: boolean, contentHash?: string) {
  const hash = contentHash ?? slotOf(await get(h), slotId).contentHash;
  return h.owner.retime(CH, WEEK, { slotId, contentHash: hash, date, publishAt: `${date}T${time}`, approve: approveToo }, "u1");
}

test("AC-RT-01: an unapproved slot moved to Tuesday 20:00 -- new time, still needs approval, by the owner, audited from/to", async () => {
  const h = await setup();
  const { plan, changed, approved } = await retime(h, "s1", "2026-10-27", "20:00", false);
  assert.equal(changed, true);
  assert.equal(approved, false);
  const s1 = slotOf(plan, "s1");
  assert.equal(s1.date, "2026-10-27");
  assert.equal(s1.publishAt, "2026-10-27T20:00");
  assert.equal(s1.publishAtUtc, "2026-10-27T11:00:00.000Z");
  assert.equal(s1.lengthHint, "≈ 10 мин");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.updatedBy, "owner");
  assert.equal(s1.contentHash, sha(["Asia/Tokyo", "2026-10-27", "2026-10-27T20:00", "≈ 10 мин", null, ["V64", AA, null]]));
  const audit = h.audits.find((a) => a.detail.event === "publishing_plan.retimed");
  assert.ok(audit);
  assert.equal(audit.slotId, "s1");
  assert.deepEqual(audit.detail.from, { date: "2026-10-26", publishAt: "2026-10-26T15:00" });
  assert.deepEqual(audit.detail.to, { date: "2026-10-27", publishAt: "2026-10-27T20:00" });
  assert.equal(audit.detail.by, "u1");
  // The other slot is untouched.
  assert.equal(slotOf(plan, "s2").publishAt, "2026-10-27T18:00");
});

test("AC-RT-02: an approved, uploaded slot moved to 17:30 with approve -- approved again; the uploads date the video at 08:30Z", async () => {
  const h = await setup("vid1");
  await approve(h, "s1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z", package: { video: "V64", manifestSha256: AA, videoId: "vid1" } , source: "owner" });
  const { plan, approved } = await retime(h, "s1", "2026-10-26", "17:30", true);
  assert.equal(approved, true);
  const s1 = slotOf(plan, "s1");
  assert.equal(s1.approval, "approved");
  assert.equal(s1.changedAfterApproval, null);
  assert.equal(s1.contentHash, sha(["Asia/Tokyo", "2026-10-26", "2026-10-26T17:30", "≈ 10 мин", null, ["V64", AA, "vid1"]]));
  const expected = { kind: "approved", publishAt: "2026-10-26T08:30:00.000Z", package: { video: "V64", manifestSha256: AA, videoId: "vid1" } , source: "owner" };
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), expected);
  // plan-schedule's rule for the finished upload of that video: the new time.
  assert.deepEqual(decisionForRow({ slotId: "s1", videoId: "vid1", manifestSha256: AA }, decisions), expected);
  // One retime audit (the old approval revoked with it) and one approval audit.
  assert.deepEqual(h.audits.map((a) => a.detail.event).slice(-2), ["publishing_plan.retimed", "publishing_plan.approved"]);
  assert.equal((h.audits.at(-2)!.detail.revoked as string[]).length, 1);
});

test("AC-RT-03: an approved slot moved WITHOUT approve -- the old approval is revoked (not «changed after approval»), the slot needs the owner, the uploads leave the date (pending)", async () => {
  const h = await setup("vid1");
  await approve(h, "s1");
  const { plan, approved } = await retime(h, "s1", "2026-10-26", "17:30", false);
  assert.equal(approved, false);
  const s1 = slotOf(plan, "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.changedAfterApproval, null);
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  const audit = h.audits.find((a) => a.detail.event === "publishing_plan.retimed")!;
  assert.equal(audit.detail.wasApproved, true);
  assert.equal((audit.detail.revoked as string[]).length, 1);
});

test("AC-RT-04: a slot changed since the screen showed it -- publishing_plan_changed, nothing written", async () => {
  const h = await setup();
  const shown = slotOf(await get(h), "s1").contentHash;
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "16:00")] }, "worker");
  const e = await refusal(retime(h, "s1", "2026-10-27", "20:00", false, shown));
  assert.equal(codeOf(e), "publishing_plan_changed");
  assert.equal(slotOf(await get(h), "s1").publishAt, "2026-10-26T16:00");
  assert.equal(h.audits.filter((a) => a.detail.event === "publishing_plan.retimed").length, 0);
});

test("AC-RT-05: outside the week, a time that does not exist, date/time mismatch -- validation_failed with the reason, nothing written", async () => {
  const h = await setup();
  assert.deepEqual(reasonsOf(await refusal(retime(h, "s1", "2026-11-02", "15:00", false))), ["outside_week"]);
  assert.deepEqual(reasonsOf(await refusal(retime(h, "s1", "2026-10-25", "15:00", false))), ["outside_week"]);
  assert.deepEqual(reasonsOf(await refusal(retime(h, "s1", "2026-10-27", "24:00", false))), ["publish_at_invalid"]);
  const hash = slotOf(await get(h), "s1").contentHash;
  const mismatch = await refusal(h.owner.retime(CH, WEEK, { slotId: "s1", contentHash: hash, date: "2026-10-27", publishAt: "2026-10-28T10:00", approve: false }, "u1"));
  assert.deepEqual(reasonsOf(mismatch), ["date_mismatch"]);
  assert.equal(slotOf(await get(h), "s1").publishAt, "2026-10-26T15:00");
});

test("AC-RT-06: the 15-minute margin -- a new time under 15 minutes away is refused (in_past); a slot coming out within 15 minutes cannot be moved", async () => {
  const h = await setup();
  // 05:00Z: s2 (Tue) moved to Monday 14:10 JST = 05:10Z, 10 minutes away.
  h.clock.now = new Date("2026-10-26T05:00:00Z");
  assert.deepEqual(reasonsOf(await refusal(retime(h, "s2", "2026-10-26", "14:10", false))), ["in_past"]);
  // 14:15 JST = 05:15Z is exactly 15 minutes away: allowed.
  assert.equal(slotOf((await retime(h, "s2", "2026-10-26", "14:15", false)).plan, "s2").publishAtUtc, "2026-10-26T05:15:00.000Z");
  // 05:50Z: s1 (06:00Z) comes out in 10 minutes.
  h.clock.now = new Date("2026-10-26T05:50:00Z");
  assert.equal(codeOf(await refusal(retime(h, "s1", "2026-10-27", "20:00", false))), "publishing_plan_slot_too_soon");
});

test("AC-RT-07: a vetoed slot and a released slot cannot be moved", async () => {
  const h = await setup();
  await h.owner.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(codeOf(await refusal(retime(h, "s2", "2026-10-28", "18:00", false))), "publishing_plan_slot_vetoed");
  h.clock.now = new Date("2026-10-26T07:00:00Z");
  assert.equal(codeOf(await refusal(retime(h, "s1", "2026-10-27", "20:00", false))), "publishing_plan_slot_past");
});

test("AC-RT-08: approve on a slot still waiting for its package -- publishing_plan_slot_not_packaged before anything is written", async () => {
  const h = await setup();
  const e = await refusal(retime(h, "s2", "2026-10-28", "18:00", true));
  assert.equal(codeOf(e), "publishing_plan_slot_not_packaged");
  assert.equal(slotOf(await get(h), "s2").publishAt, "2026-10-27T18:00");
  // Without approve the same move is saved.
  assert.equal(slotOf((await retime(h, "s2", "2026-10-28", "18:00", false)).plan, "s2").publishAt, "2026-10-28T18:00");
});

test("AC-RT-09: an agent saving the old time back after the owner's move does not inherit the approval -- the slot needs the owner again", async () => {
  const h = await setup("vid1");
  await approve(h, "s1");
  await retime(h, "s1", "2026-10-26", "17:30", true);
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "15:00")] }, "worker");
  const s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
});

test("AC-RT-10: retime is the owner's only -- the agents' surface has no retime, and no MCP file names the retime route or schema", async () => {
  const h = harness();
  assert.equal("retime" in agentSurface(h.service), false);
  const SRC = path.resolve(process.cwd(), "src");
  const offenders: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && /[/\\](mcp)[/\\]|[/\\]api[/\\]mcp/.test(full)) {
        if (/\bretime\b|ownerRetimeInputSchema/.test(await readFile(full, "utf8"))) offenders.push(path.relative(SRC, full));
      }
    }
  }
  await walk(SRC);
  assert.deepEqual(offenders, []);
});

test("AC-RT-11: an agent changed an approved slot, then the owner moves it -- the approval the agent's change left standing is revoked too", async () => {
  const h = await setup("vid1");
  await approve(h, "s1");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "16:00")] }, "worker");
  assert.ok(slotOf(await get(h), "s1").changedAfterApproval);
  await retime(h, "s1", "2026-10-26", "17:30", false);
  // The agent puts the time the owner once approved back: that approval no longer counts.
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "15:00")] }, "worker");
  assert.equal(slotOf(await get(h), "s1").approval, "needs_approval");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
});

test("AC-RT-12 (review 1): the margin counts the soonest date the video may carry -- an approved time an agent's change still stands on, and the date on YouTube", async () => {
  // Approved 15:00 JST (06:00Z), an agent moved the slot to 23:00; at 05:50Z the 06:00Z approval still stands for the uploaded video.
  const h = await setup("vid1");
  await approve(h, "s1");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "23:00")] }, "worker");
  h.clock.now = new Date("2026-10-26T05:50:00Z");
  assert.equal(codeOf(await refusal(retime(h, "s1", "2026-10-27", "20:00", true))), "publishing_plan_slot_too_soon");
  // A slot at 23:00 whose uploaded video carries 06:00Z on YouTube (no approval left): also too soon.
  const g = await setup("vid2");
  g.progress.set("s1", { status: "scheduled", code: null, videoId: "vid2", package: pkg(), publishAt: "2026-10-26T06:00:00.000Z" });
  await g.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "23:00")] }, "worker");
  g.clock.now = new Date("2026-10-26T05:50:00Z");
  assert.equal(codeOf(await refusal(retime(g, "s1", "2026-10-27", "20:00", false))), "publishing_plan_slot_too_soon");
});

test("AC-RT-13 (review 4): a new time approved in the same step is at least 30 minutes away; without approve 15 is enough", async () => {
  const h = await setup();
  h.clock.now = new Date("2026-10-26T04:00:00Z");
  // s1 15:00 JST = 06:00Z; 13:20 JST = 04:20Z is 20 minutes away.
  assert.deepEqual(reasonsOf(await refusal(retime(h, "s1", "2026-10-26", "13:20", true))), ["in_past"]);
  assert.equal(slotOf((await retime(h, "s1", "2026-10-26", "13:30", true)).plan, "s1").approval, "approved");
  assert.equal(slotOf((await retime(h, "s1", "2026-10-26", "13:20", false)).plan, "s1").publishAt, "2026-10-26T13:20");
});

test("AC-RT-14 (review 2): re-approving a moved slot that replaces another does not veto the replaced slot again after the owner restored it", async () => {
  const h = await setup();
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [{ ...slot("s3", "2026-10-28", "18:00"), replacesSlotId: "s2" }] }, "factory");
  h.progress.set("s3", { status: "packaged", code: null, videoId: null, package: pkg({ video: "V65", manifestSha256: "c".repeat(64) }) });
  await approve(h, "s3");
  assert.ok(slotOf(await get(h), "s2").vetoed);
  await h.owner.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s2" }] }, "u1");
  await retime(h, "s3", "2026-10-28", "19:00", true);
  const plan = await get(h);
  assert.equal(slotOf(plan, "s3").approval, "approved");
  assert.equal(slotOf(plan, "s2").vetoed, null);
});

test("AC-RT-15 (review 6): every earlier approval of the slot is revoked by the owner's move, not only the latest", async () => {
  const h = await setup("vid1");
  await approve(h, "s1"); // A = 15:00
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "16:00")] }, "worker");
  await approve(h, "s1"); // B = 16:00 (A never revoked)
  await retime(h, "s1", "2026-10-26", "17:30", false);
  for (const time of ["15:00", "16:00"]) {
    await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", time)] }, "worker");
    assert.equal(slotOf(await get(h), "s1").approval, "needs_approval", time);
    assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" }, time);
  }
});
