import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument, isDomainError, type PublishingPlansDocument } from "@/lib/sync-gateway/publishing-plans";
import { createPublishingPlansService } from "./services";
import type { WeekTemplateDays } from "@/lib/sync-gateway";
import { matchSlots, templateHashOf, templateInForce, validateTemplate, type MatchSlot } from "./template";

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.1-§3.3, §9 AC-WT-01..05 and AC-WT-07..13; ADR 0073 §1-§2; owner O4, Producer P1-P3, Operator Op2/Op3).
// Expected values by hand from the plan: a short is <= 180 s; `hours` ±10 % (3 h: 9720..11880 s, 8 h: 25920..31680 s); the weekday and
// minute are UTC; two same-kind slots on one position -> the first created takes it. Fixtures are the owner's templates (WWE, Tropico).

const CH = "UC_wwe";
const WWE = {
  format: "week-template/1",
  channelId: CH,
  horizonWeeks: 2,
  displayTimeZone: "Europe/Moscow",
  days: {
    mon: [{ kind: "long", publishTimeUtc: "15:00" }, { kind: "short", publishTimeUtc: "12:00" }],
    tue: [{ kind: "short", publishTimeUtc: "12:00" }],
    wed: [{ kind: "long", publishTimeUtc: "15:00" }, { kind: "short", publishTimeUtc: "12:00" }],
    thu: [{ kind: "short", publishTimeUtc: "12:00" }],
    fri: [{ kind: "long", publishTimeUtc: "15:00" }, { kind: "short", publishTimeUtc: "12:00" }],
    sat: [{ kind: "short", publishTimeUtc: "12:00" }],
    sun: [{ kind: "short", publishTimeUtc: "12:00" }],
  },
};
const daily3h = { kind: "long", hours: 3, publishTimeUtc: "12:00" };
const TROPICO = { format: "week-template/1", channelId: "UC_tropico", horizonWeeks: 2, days: { mon: [daily3h], tue: [daily3h], wed: [daily3h], thu: [daily3h], fri: [{ kind: "long", hours: 8, publishTimeUtc: "12:00" }], sat: [daily3h], sun: [daily3h] } };
const zone = (z: string) => z === "Europe/Moscow" || z === "Asia/Tokyo";

function daysOf(input: unknown, channelId = CH): WeekTemplateDays {
  const v = validateTemplate(input, channelId, zone);
  if (!v.ok) throw new Error(JSON.stringify(v.refused));
  return v.content.days;
}
const wweDays = () => daysOf(WWE);
const tropicoDays = () => daysOf(TROPICO, "UC_tropico");
const slot = (slotId: string, iso: string, durationSeconds: number | null, over: Partial<MatchSlot> = {}): MatchSlot => ({ slotId, instant: new Date(iso), createdAt: "2026-11-16T10:00:00Z", vetoed: false, durationSeconds, video: "V1", ...over });

test("AC-WT-01: a valid template is accepted; each wrong field is refused with its reason", () => {
  assert.equal(validateTemplate(WWE, CH, zone).ok, true);
  const reasons = (input: unknown) => {
    const r = validateTemplate(input, CH, zone);
    return r.ok ? [] : r.refused.map((x) => x.reason);
  };
  assert.deepEqual(reasons({ ...WWE, extra: 1 }), ["unknown_field"]);
  assert.deepEqual(reasons({ ...WWE, channelId: "UC_other" }), ["channel_mismatch"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "short", hours: 1, publishTimeUtc: "12:00" }] } }), ["hours_on_short"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "long", hours: 0.2, publishTimeUtc: "12:00" }] } }), ["hours_invalid"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "long", hours: 12.25, publishTimeUtc: "12:00" }] } }), ["hours_invalid"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "long", publishTimeUtc: "15:03" }] } }), ["time_invalid"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "long", publishTimeUtc: "24:00" }] } }), ["time_invalid"]);
  const seven = Array.from({ length: 7 }, (_, i) => ({ kind: "long", publishTimeUtc: `1${i}:00` }));
  assert.deepEqual(reasons({ ...WWE, days: { mon: seven } }), ["too_many_entries"]);
  assert.deepEqual(reasons({ ...WWE, days: { mon: [{ kind: "long", publishTimeUtc: "15:00" }, { kind: "long", publishTimeUtc: "15:00" }] } }), ["template_duplicate_entry"]);
  assert.deepEqual(reasons({ ...WWE, horizonWeeks: 9 }), ["horizon_invalid"]);
  assert.deepEqual(reasons({ ...WWE, displayTimeZone: "Mars/Base" }), ["time_zone_invalid"]);
});

test("the content hash ignores entry order inside a day but names the zone and horizon", () => {
  const a = validateTemplate(WWE, CH, zone) as { ok: true; content: Parameters<typeof templateHashOf>[0] };
  const b = validateTemplate({ ...WWE, days: { ...WWE.days, mon: [...WWE.days.mon].reverse() } }, CH, zone) as typeof a;
  assert.equal(templateHashOf(a.content), templateHashOf(b.content));
  assert.notEqual(templateHashOf(a.content), templateHashOf({ ...a.content, horizonWeeks: 3 }));
});

test("AC-WT-07/08: WWE Monday long at exactly 15:00Z matches; 14:59Z / 15:01Z do not; a short is <= 180 s", () => {
  const days = wweDays();
  // 2026-11-23 is a Monday.
  const m = matchSlots(days, [slot("a", "2026-11-23T15:00:00Z", 600), slot("b", "2026-11-23T14:59:00Z", 600, { createdAt: "2026-11-16T10:01:00Z" }), slot("c", "2026-11-23T15:01:00Z", 600)]);
  assert.equal(m.get("a")?.state, "match");
  assert.equal(m.get("b")?.state, "off_template");
  assert.equal(m.get("c")?.state, "off_template");
  const s = matchSlots(days, [slot("s180", "2026-11-24T12:00:00Z", 180), slot("s181", "2026-11-25T12:00:00Z", 181)]);
  assert.equal(s.get("s180")?.state, "match");
  assert.equal(s.get("s181")?.state, "off_template", "a 181 s video is long; Wednesday 12:00Z has only a short");
});

test("AC-WT-09: Tropico 3 h bucket is 9720..11880 s; Friday is 8 h only (P2)", () => {
  const days = tropicoDays();
  // 2026-11-23 Mon .. 2026-11-27 Fri; one slot per day so positions never collide.
  const m = matchSlots(days, [
    slot("lo", "2026-11-23T12:00:00Z", 9720),
    slot("hi", "2026-11-24T12:00:00Z", 11880),
    slot("under", "2026-11-25T12:00:00Z", 9719),
    slot("over", "2026-11-26T12:00:00Z", 11881),
    slot("fri8", "2026-11-27T12:00:00Z", 28800),
  ]);
  assert.deepEqual(["lo", "hi", "under", "over", "fri8"].map((id) => m.get(id)?.state), ["match", "match", "off_template", "off_template", "match"]);
  assert.equal(matchSlots(days, [slot("fri3", "2026-11-27T12:00:00Z", 10800)]).get("fri3")?.state, "off_template");
});

test("AC-WT-10: the weekday is UTC -- Tue 00:30 JST (= Mon 15:30Z) is Monday", () => {
  const days = daysOf({ ...WWE, days: { mon: [{ kind: "long", publishTimeUtc: "15:30" }] } });
  assert.equal(matchSlots(days, [slot("x", "2026-11-23T15:30:00Z", 600)]).get("x")?.state, "match");
});

// Entry indexes are of the canonical (time-sorted) day: WWE Monday = [short 12:00, long 15:00].
test("AC-WT-11 (O4): two shorts on one position -- the first created takes it; vetoed claims nothing; long and short are separate", () => {
  const days = wweDays();
  const two = matchSlots(days, [slot("late", "2026-11-23T12:00:00Z", 60, { createdAt: "2026-11-16T11:00:00Z" }), slot("early", "2026-11-23T12:00:00Z", 60, { createdAt: "2026-11-16T10:00:00Z" })]);
  assert.equal(two.get("early")?.state, "match");
  assert.deepEqual(two.get("late"), { state: "position_taken", position: { date: "2026-11-23", day: "mon", index: 0 }, heldBy: "early" });
  const tie = matchSlots(days, [slot("b", "2026-11-23T12:00:00Z", 60), slot("a", "2026-11-23T12:00:00Z", 60)]);
  assert.equal(tie.get("a")?.state, "match", "equal createdAt: the smaller slot id first");
  const vetoed = matchSlots(days, [slot("early", "2026-11-23T12:00:00Z", 60, { vetoed: true }), slot("late", "2026-11-23T12:00:00Z", 60, { createdAt: "2026-11-16T11:00:00Z" })]);
  assert.equal(vetoed.get("late")?.state, "match");
  // A long and a short at one instant are separate positions (a template could have both at 12:00).
  const both = daysOf({ ...WWE, days: { mon: [{ kind: "long", publishTimeUtc: "12:00" }, { kind: "short", publishTimeUtc: "12:00" }] } });
  const m = matchSlots(both, [slot("L", "2026-11-23T12:00:00Z", 600), slot("S", "2026-11-23T12:00:00Z", 60)]);
  assert.deepEqual([m.get("L")?.state, m.get("S")?.state], ["match", "match"]);
});

test("AC-WT-12/13: an S code over 180 s is unclear; a slot on a template time without a package awaits it", () => {
  const days = wweDays();
  assert.equal(matchSlots(days, [slot("s7", "2026-11-23T15:00:00Z", 200, { video: "S7" })]).get("s7")?.state, "kind_unclear");
  assert.equal(matchSlots(days, [slot("e", "2026-11-23T15:00:00Z", null, { video: null })]).get("e")?.state, "on_template_awaiting_package");
});

// --- storage and owner decisions (AC-WT-02..05) ---

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
}

function harness(core = computer(), prefix = "m") {
  const audits: Array<Record<string, unknown>> = [];
  let wakes = 0;
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async () => true,
    deviceLabel: async () => "Mac",
    now: () => new Date("2026-11-16T12:00:00Z"),
    randomId: () => `${prefix}${(n += 1)}`,
    withLock: (fn) => fn(),
    audit: async (e) => void audits.push(e.detail),
    notifyOwnerDecision: () => void (wakes += 1),
  });
  return { core, service, audits, wakes: () => wakes };
}

test("AC-WT-04: the owner's edit is one version + one approved decision in ONE change, audited, one Producer wake; the same again writes nothing", async () => {
  const h = harness();
  const heads = async () => (await h.core.exportBytes(CH).catch(() => new Uint8Array())).length;
  const saved = await h.service.templateOwnerSave(CH, { template: WWE }, "u1");
  assert.equal(saved.changed, true);
  assert.equal(saved.template?.horizonWeeks, 2);
  const snap = await h.core.read(CH);
  assert.equal(Object.keys(snap.templateVersions ?? {}).length, 1);
  assert.equal(Object.keys(snap.templateDecisions ?? {}).length, 1);
  assert.deepEqual(h.audits.map((a) => a.event), ["publishing_plan.template_approved"]);
  assert.equal(h.wakes(), 1);
  const before = await heads();
  assert.equal((await h.service.templateOwnerSave(CH, { template: WWE }, "u1")).changed, false);
  assert.equal(await heads(), before);
});

test("AC-WT-02/03: in force = newest approved with a matching hash; withdraw -> none; a proposal dates nothing until accepted", async () => {
  const h = harness();
  const proposed = await h.service.templatePropose(CH, WWE);
  assert.equal(proposed.proposed, true);
  assert.equal(proposed.template, null, "a proposal is not in force");
  assert.equal(proposed.proposal?.by, "producer");
  const accepted = await h.service.templateOwnerDecide(CH, { action: "accept", versionId: proposed.proposal!.versionId, contentHash: proposed.proposal!.contentHash }, "u1");
  assert.equal(accepted.template?.versionId, proposed.proposal!.versionId);
  assert.equal(accepted.proposal, null);
  const withdrawn = await h.service.templateOwnerWithdraw(CH, "u1");
  assert.equal(withdrawn.template, null);
  // A version whose stored content no longer matches its hash is not in force (fail closed).
  const snap = await h.core.read(CH);
  const version = Object.values(snap.templateVersions!)[0];
  const tampered = { ...snap, templateVersions: { [version.id]: { ...version, horizonWeeks: 5 } }, templateDecisions: { d: { id: "d", versionId: version.id, contentHash: version.contentHash, kind: "approved" as const, by: "owner" as const, device: null, at: "2026-11-17T00:00:00Z", seq: 99 } } };
  assert.equal(templateInForce(tampered), null);
  // A stale hash is refused.
  await assert.rejects(h.service.templateOwnerDecide(CH, { action: "accept", versionId: version.id, contentHash: "0".repeat(64) }, "u1"), (e) => isDomainError(e) && e.code === "publishing_plan_changed");
});

test("AC-WT-05: two computers each write a first template version; after merge both are readable and seq decides", async () => {
  const mac = harness();
  const win = harness(computer(), "w");
  await mac.service.templateOwnerSave(CH, { template: WWE }, "u1");
  await win.service.templateOwnerSave(CH, { template: { ...WWE, horizonWeeks: 3 } }, "u1");
  // Windows's decision is made after it saw nothing: same seq 1; make the Mac decide again after a merge so seq orders it.
  const macBytes = await mac.core.exportBytes(CH);
  const winBytes = await win.core.exportBytes(CH);
  await mac.core.mergeIncoming(CH, winBytes);
  await win.core.mergeIncoming(CH, macBytes);
  const a = await mac.core.read(CH);
  const b = await win.core.read(CH);
  assert.equal(Object.keys(a.templateVersions ?? {}).length, 2, "both first versions survive the root-key conflict");
  assert.deepEqual(Object.keys(a.templateVersions ?? {}).sort(), Object.keys(b.templateVersions ?? {}).sort());
  assert.equal(templateInForce(a)?.version.id, templateInForce(b)?.version.id, "both computers agree");
  // The Mac now edits once more: seq 2 wins everywhere.
  await mac.service.templateOwnerSave(CH, { template: { ...WWE, horizonWeeks: 4 } }, "u1");
  await win.core.mergeIncoming(CH, await mac.core.exportBytes(CH));
  assert.equal(templateInForce(await win.core.read(CH))?.version.horizonWeeks, 4);
});
