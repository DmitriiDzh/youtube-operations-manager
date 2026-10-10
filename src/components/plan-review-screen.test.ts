import assert from "node:assert/strict";
import test from "node:test";
import { formatPlayerTime } from "./media-review-player";
import { createTranslator } from "@/lib/ui-text";
import type { PlanCheck } from "@/lib/generation-plans/contracts";
import { beforeLufs, failedChecksOf, filterEntries, findingMarkers, historyLineOf, nextWaitingIndex, peerQueue, peerRecheckEntries, playedLufs, recheckMarkers, recheckPickerOption, REVIEW_REASONS, reviewKeyAction } from "./plan-review-screen";

// BL-152: the spectrogram marks' labels are translated; the requirement checked here is the English wording.
const t = createTranslator("en");

// BL-143 (MEDIA_REVIEW_TOOLS.md §2 group A; FO-MSG-0008 §6; owner msgs 1933/1939): the review screen's keyboard map,
// queue order, reasons, finding markers and time display.

test("keyboard: Space plays, arrows seek, A/R decide, N/P move, M marks, digits rate (0 = 10)", () => {
  assert.equal(reviewKeyAction(" "), "play");
  assert.equal(reviewKeyAction("ArrowLeft"), "back");
  assert.equal(reviewKeyAction("ArrowRight"), "forward");
  assert.equal(reviewKeyAction("a"), "accept");
  assert.equal(reviewKeyAction("R"), "reject");
  assert.equal(reviewKeyAction("n"), "next");
  assert.equal(reviewKeyAction("P"), "previous");
  assert.equal(reviewKeyAction("m"), "mark");
  assert.deepEqual(reviewKeyAction("7"), { rating: 7 });
  assert.deepEqual(reviewKeyAction("0"), { rating: 10 });
  assert.equal(reviewKeyAction("x"), null);
  assert.equal(reviewKeyAction("Enter"), null);
});

test("after a verdict the queue moves to the next attempt still waiting, wrapping; -1 when none is left", () => {
  const e = (verdict: unknown) => ({ verdict });
  assert.equal(nextWaitingIndex([e("x"), e(null), e("x"), e(null)], 1), 3);
  assert.equal(nextWaitingIndex([e(null), e("x"), e("x")], 1), 0, "wraps");
  assert.equal(nextWaitingIndex([e("x"), e("x")], 0), -1);
});

test("the reasons are the R-0001 list; the validator's timed findings become waveform ranges", () => {
  assert.deepEqual([...REVIEW_REASONS].slice(0, 2), ["thin / sparse", "dropout / pause"]);
  assert.equal(REVIEW_REASONS.length, 10);
  const check = (id: string, atSeconds: [number, number] | null, label: string | null = null) => ({ id, label, value: 1, unit: null, threshold: null, pass: false, severity: "fail" as const, atSeconds, detail: null });
  const markers = findingMarkers({ stages: [{ stageId: "validate", itemKey: "C1", attemptRef: "job:1", result: "rejected", reportedBy: "factory", note: null, rating: null, reasons: [], markers: [], auditionFile: null, checks: [check("internal_gap_s", [5.55, 6.5], "Dropout"), check("ring_db", null)], metrics: {}, at: "" }] });
  assert.deepEqual(markers, [{ start: 5.55, end: 6.5, label: "Dropout", tone: "finding" }]);
});

test("player time reads m:ss.t", () => {
  assert.equal(formatPlayerTime(111.25), "1:51.2");
  assert.equal(formatPlayerTime(0), "0:00.0");
  assert.equal(formatPlayerTime(Number.NaN), "0:00.0");
});

// BL-143 phase 2 (GENERATION_PLANS_PHASE_2_PLAN.md AC-GP2-03/06): another device's queue counts a verdict sent from here as
// given ("sent, waiting for <device>") until that device's report shows it applied.
test("peer queue: a sent verdict marks the entry as waiting for the owning device; an applied one comes from the report", async () => {
  const { peerQueue } = await import("./plan-review-screen");
  const entry = (attemptRef: string, verdict: unknown = null) => ({ itemKey: "C1/F1", groupId: "C1", attemptRef, jobId: null, seed: null, params: {}, stages: [], verdict, playable: true }) as never;
  const data = {
    devices: [{ deviceId: "mac", hostname: "Mac", plans: [{ planId: "P", review: [entry("job:1"), entry("job:2"), entry("job:3", { result: "accepted", reportedBy: "owner", note: "(from Windows PC)" })] }] }],
    outgoing: [{ planId: "P", ownerDeviceId: "mac", itemKey: "C1/F1", attemptRef: "job:2", result: "rejected" as const, rating: 5, at: "2026-10-07T12:00:00.000Z" }],
  };
  const queue = peerQueue(data, { deviceId: "mac", hostname: "Mac" }, "P");
  assert.equal(queue[0].verdict, null);
  assert.deepEqual([queue[1].verdict?.result, queue[1].verdict?.note, queue[1].verdict?.rating], ["rejected", "sent, waiting for Mac", 5]);
  assert.equal(queue[2].verdict?.note, "(from Windows PC)");
  assert.deepEqual(peerQueue(data, { deviceId: "linux", hostname: null }, "P"), []);
});

test("peer queue: once the owning device shows the verdict (stored to the whole second), it is no longer 'sent, waiting'; params come from itemParams by own key only", async () => {
  const { peerQueue } = await import("./plan-review-screen");
  const applied = { result: "rejected", reportedBy: "owner", note: "(from Windows PC)", at: "2026-10-07T12:00:05.000Z" };
  const entry = { itemKey: "constructor", groupId: null, attemptRef: "job:1", jobId: null, seed: null, params: {}, stages: [], verdict: applied, playable: true } as never;
  const data = {
    devices: [{ deviceId: "mac", hostname: "Mac", plans: [{ planId: "P", review: [entry], itemParams: { constructor: { prompt: "koto" } } }] }],
    outgoing: [{ planId: "P", ownerDeviceId: "mac", itemKey: "constructor", attemptRef: "job:1", result: "rejected" as const, rating: null, at: "2026-10-07T12:00:05.678Z" }],
  };
  const [shown] = peerQueue(data, { deviceId: "mac", hostname: "Mac" }, "P");
  assert.equal(shown.verdict?.note, "(from Windows PC)", "the applied verdict, not 'sent, waiting'");
  assert.deepEqual(shown.params, { prompt: "koto" });
  const noParams = peerQueue({ ...data, devices: [{ ...data.devices[0], plans: [{ planId: "P", review: [entry], itemParams: {} }] }] }, { deviceId: "mac", hostname: "Mac" }, "P");
  assert.deepEqual(noParams[0].params, {}, "an inherited name (constructor) is never taken as params");
});

test("AC-GP3-04: the validator's LUFS is the latest stage's metrics.lufs; without one it is unknown (then measured in the browser)", async () => {
  const { reportedLufs } = await import("./plan-review-screen");
  const row = (stageId: string, metrics: Record<string, unknown>) => ({ stageId, itemKey: "a", attemptRef: "job:1", result: "accepted" as const, reportedBy: "factory" as const, note: null, rating: null, reasons: [], markers: [], auditionFile: null, checks: [], metrics: metrics as never, at: "" });
  assert.equal(reportedLufs({ stages: [row("postprocess", { lufs: -14 }), row("validate", { lufs: -14.2, key: "D major" })] }), -14.2);
  assert.equal(reportedLufs({ stages: [row("postprocess", { lufs: -13 }), row("validate", { key: "D" })] }), -13);
  assert.equal(reportedLufs({ stages: [row("validate", { lufs: "loud" })] }), null);
  assert.equal(reportedLufs({ stages: [] }), null);
});

test("FO-MSG-0009 §4: ringing tones and a held note become spectrogram marks; A/B offers the attempt's nearest references first", async () => {
  const { frequencyMarksOf: marksOf, referencesFor, reviewKeyAction } = await import("./plan-review-screen");
  const frequencyMarksOf = (entry: Parameters<typeof marksOf>[1]) => marksOf(t, entry);
  const row = (checks: unknown[], metrics: Record<string, unknown>, referenceIds: string[] = []) => ({ stageId: "validate", itemKey: "a", attemptRef: "job:1", result: "rejected" as const, reportedBy: "factory" as const, note: null, rating: null, reasons: [], markers: [], auditionFile: null, checks: checks as never, metrics: metrics as never, referenceIds, at: "" });
  const check = (id: string, detail: string | null) => ({ id, label: null, value: null, unit: null, threshold: null, pass: false, severity: "fail", atSeconds: null, detail });
  assert.deepEqual(frequencyMarksOf({ stages: [row([check("ring_db", "tones 11000, 14098 Hz"), check("style", "0.92")], { held_hz: 440 })] }), [
    { hz: 11000, label: "ringing" },
    { hz: 14098, label: "ringing" },
    { hz: 440, label: "held note" },
  ]);
  const refs = [{ id: "a", label: "A", file: "reference/a.mp3", lufs: null, lra: null, truePeak: null }, { id: "b", label: "B", file: "reference/b.mp3", lufs: -13, lra: null, truePeak: null }];
  assert.deepEqual(referencesFor({ stages: [row([], {}, ["b"])] }, refs).map((r) => [r.id, r.nearest]), [["b", true], ["a", false]]);
  assert.equal(reviewKeyAction("b"), "ab");
});

test("phase 3 review: only the Hz list of a FAILED ringing check is marked (not dB or seconds); kHz is understood", async () => {
  const { frequencyMarksOf: marksOf } = await import("./plan-review-screen");
  const frequencyMarksOf = (entry: Parameters<typeof marksOf>[1]) => marksOf(t, entry);
  const row = (checks: unknown[]) => ({ stageId: "validate", itemKey: "a", attemptRef: "job:1", result: "rejected" as const, reportedBy: "factory" as const, note: null, rating: null, reasons: [], markers: [], auditionFile: null, checks: checks as never, metrics: {} as never, referenceIds: [], at: "" });
  const check = (id: string, detail: string, pass = false) => ({ id, label: null, value: null, unit: null, threshold: null, pass, severity: "fail", atSeconds: null, detail });
  assert.deepEqual(frequencyMarksOf({ stages: [row([check("ring_db", "tones 2751 Hz at -32 dB over 40 s")])] }).map((m) => m.hz), [2751]);
  assert.deepEqual(frequencyMarksOf({ stages: [row([check("ring_db", "tone 8.5 kHz")])] }).map((m) => m.hz), [8500]);
  assert.deepEqual(frequencyMarksOf({ stages: [row([check("ring_db", "tones 2751, 8500 Hz", true)])] }), [], "a passing check marks nothing");
  assert.deepEqual(frequencyMarksOf({ stages: [row([check("string_noise", "1000 Hz")])] }), [], "not a ringing check");
});

// BL-153 (docs/roadmap/plans/REVIEW_REJECTED_PLAN.md AC-RR-06/07), written before the screen code.
const row = (result: "accepted" | "rejected", checks: Array<Partial<PlanCheck> & { id: string }>) => ({
  stageId: "validate",
  itemKey: "A/1",
  attemptRef: "job:x",
  result,
  reportedBy: "factory" as const,
  note: null,
  rating: null,
  reasons: [],
  markers: [],
  auditionFile: null,
  checks: checks.map((c) => ({ label: null, value: null, unit: null, threshold: null, pass: true, severity: "info" as const, atSeconds: null, detail: null, ...c })),
  metrics: {},
  at: "2026-10-08T09:00:00Z",
});

test("AC-RR-06: the filter keeps the queue's order; an entry from another device (no `validator`) is judged by its stage rows", () => {
  const entries = [
    { id: 1, validator: "passed" as const, stages: [] },
    { id: 2, validator: "rejected" as const, stages: [] },
    { id: 3, stages: [row("rejected", [])] },
    { id: 4, stages: [row("accepted", [])] },
  ];
  assert.deepEqual(filterEntries(entries, "all").map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(filterEntries(entries, "passed").map((e) => e.id), [1, 4]);
  assert.deepEqual(filterEntries(entries, "rejected").map((e) => e.id), [2, 3]);
});

test("AC-RR-07: failed checks -- fail before warn, passing and info ones left out, distance from the threshold in percent", () => {
  const entry = {
    stages: [
      row("rejected", [
        { id: "width", label: "Stereo width", value: 1, threshold: 0.9, pass: false, severity: "warn" },
        { id: "loop", label: "Loop", value: 0.53, threshold: 0.36, pass: false, severity: "fail", atSeconds: [28, 31] },
        { id: "lufs", value: -14, threshold: -16, pass: true, severity: "fail" },
        { id: "note", value: "x", threshold: null, pass: false, severity: "info" },
        { id: "held", value: 0.86, threshold: 0.84, pass: false, severity: "fail" },
      ]),
    ],
  };
  // 0.53 vs 0.36: |0.17| / 0.36 = 47 %; 0.86 vs 0.84: 2 %; 1 vs 0.9: 11 %.
  assert.deepEqual(
    failedChecksOf(entry).map((c) => [c.label, c.severity, c.offPercent, c.atSeconds]),
    [["Loop", "fail", 47, [28, 31]], ["held", "fail", 2, null], ["Stereo width", "warn", 11, null]]
  );
  assert.deepEqual(failedChecksOf({ stages: [row("accepted", [{ id: "loop", pass: false, severity: "fail" }])] }), [], "a passed attempt shows no line");
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-01/02/05): review by wave -- each wave's waiting and reviewed counts, the walk inside a
// wave, the "wave done" numbers. Expected values are counted by hand from the entries below.
test("AC-WV-01/05: wave summaries in the plan's wave order -- waiting passed/rejected, reviewed of total, the owner's counts", async () => {
  const { waveSummaries } = await import("./plan-review-screen");
  const verdict = (result: "accepted" | "rejected") => ({ stageId: "owner_review", itemKey: "", attemptRef: "", result, reportedBy: "owner", note: null, rating: null, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: "2026-10-08T10:00:00Z" });
  const e = (groupId: string | null, validator: "passed" | "rejected", v: "accepted" | "rejected" | null) => ({ groupId, validator, stages: [], verdict: v ? verdict(v) : null });
  const entries = [
    e("C14", "passed", null),
    e("C14", "rejected", null),
    e("C14", "rejected", "accepted"),
    e("C13", "passed", "rejected"),
    e("C13", "passed", "accepted"),
    e(null, "passed", null),
    e("C99", "passed", null),
  ];
  const batches = [{ groupId: "C13", title: "C13 planner off" }, { groupId: "C14", title: "C14 new instruments" }, { groupId: "C15", title: "C15" }];
  assert.deepEqual(waveSummaries(entries as never, batches), [
    { groupId: "C13", title: "C13 planner off", total: 2, reviewed: 2, waitingPassed: 0, waitingRejected: 0, accepted: 1, rejected: 1, overridesValidator: 0 },
    { groupId: "C14", title: "C14 new instruments", total: 3, reviewed: 1, waitingPassed: 1, waitingRejected: 1, accepted: 1, rejected: 0, overridesValidator: 1 },
    // A wave the batches do not name (an older report) comes last, titled by its id; C15 has no entries; no-wave entries are not a wave.
    { groupId: "C99", title: "C99", total: 1, reviewed: 0, waitingPassed: 1, waitingRejected: 0, accepted: 0, rejected: 0, overridesValidator: 0 },
  ]);
});

test("AC-WV-02: the walk is the validator filter, then the chosen wave", async () => {
  const { visibleEntries } = await import("./plan-review-screen");
  const e = (id: string, groupId: string | null, validator: "passed" | "rejected") => ({ id, groupId, validator, stages: [] });
  const entries = [e("a", "C14", "passed"), e("b", "C14", "rejected"), e("c", "C13", "rejected"), e("d", null, "passed")];
  assert.deepEqual(visibleEntries(entries, "all", null).map((x) => x.id), ["a", "b", "c", "d"]);
  assert.deepEqual(visibleEntries(entries, "all", "C14").map((x) => x.id), ["a", "b"]);
  assert.deepEqual(visibleEntries(entries, "rejected", "C14").map((x) => x.id), ["b"]);
  assert.deepEqual(visibleEntries(entries, "rejected", null).map((x) => x.id), ["b", "c"]);
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-02, AC-WV-06): a track another computer is reviewing is marked and passed over.
test("AC-TC-02: claimOf -- a live claim on the track or its wave; expired or other tracks' claims do not count", async () => {
  const { claimOf } = await import("./plan-review-screen");
  const now = Date.parse("2026-10-08T16:35:00Z");
  const claim = (over: Record<string, unknown>) => ({ scope: "attempt" as const, itemKey: "C14/F1", attemptRef: "job:j1", groupId: null, device: "DESKTOP-B0UCB4I", since: "2026-10-08T16:31:00Z", until: "2026-10-08T16:41:00Z", ...over });
  const entry = { itemKey: "C14/F1", attemptRef: "job:j1", groupId: "C14" };
  assert.equal(claimOf(entry, [claim({})], now)?.device, "DESKTOP-B0UCB4I");
  assert.equal(claimOf(entry, [claim({ until: "2026-10-08T16:34:59Z" })], now), null, "expired");
  assert.equal(claimOf(entry, [claim({ attemptRef: "job:j2" })], now), null, "another track");
  assert.equal(claimOf(entry, [claim({ scope: "group", itemKey: null, attemptRef: null, groupId: "C14" })], now)?.groupId, "C14", "its wave");
  assert.equal(claimOf(entry, [claim({ scope: "group", itemKey: null, attemptRef: null, groupId: "C13" })], now), null, "another wave");
  assert.equal(claimOf({ ...entry, groupId: null }, [claim({ scope: "group", itemKey: null, attemptRef: null, groupId: null })], now), null, "no wave is no wave claim");
});

test("AC-TC-02: the arrows and 'next waiting' pass over skipped tracks, wrapping; with everything skipped they stay put", async () => {
  const { nextWaitingIndex, stepIndex } = await import("./plan-review-screen");
  const entries = [{ id: "a", verdict: null }, { id: "b", verdict: null }, { id: "c", verdict: {} }, { id: "d", verdict: null }];
  const skipB = (e: { id: string }) => e.id === "b";
  assert.equal(stepIndex(entries, 0, 1, skipB), 2);
  assert.equal(stepIndex(entries, 2, -1, skipB), 0);
  assert.equal(stepIndex(entries, 0, -1, skipB), 3, "wraps");
  assert.equal(stepIndex(entries, 1, 1, () => true), 1, "all skipped: stays");
  assert.equal(nextWaitingIndex(entries, 0, skipB), 3, "b is claimed, c is reviewed");
  assert.equal(nextWaitingIndex(entries, 0), 1, "without skipping, as before");
});

// Review round 5 (BL-157, AC-WV-02/06): "next wave" skips a wave another computer is on -- unless the owner shows claimed ones.
test("AC-WV-02/06: the next-wave offer -- the next wave with a waiting track this computer may take, in plan order, wrapping", async () => {
  const { nextOpenWave } = await import("./plan-review-screen");
  const wave = (groupId: string, waiting: number) => ({ groupId, title: groupId, total: 3, reviewed: 3 - waiting, waitingPassed: waiting, waitingRejected: 0, accepted: 0, rejected: 0, overridesValidator: 0 });
  const waves = [wave("C1", 0), wave("C2", 2), wave("C3", 1)];
  const entries = [
    { id: "c2a", groupId: "C2", verdict: null },
    { id: "c2b", groupId: "C2", verdict: null },
    { id: "c3a", groupId: "C3", verdict: null },
  ];
  const claimedOnMac = new Set(["c2a", "c2b"]);
  assert.equal(nextOpenWave(waves, waves[0], entries, () => false)?.groupId, "C2");
  assert.equal(nextOpenWave(waves, waves[0], entries, (e) => claimedOnMac.has(e.id))?.groupId, "C3", "C2 is all taken by the Mac");
  assert.equal(nextOpenWave(waves, waves[0], entries, () => true), null, "nothing this computer may take");
  assert.equal(nextOpenWave(waves, waves[1], entries, () => false), null, "the chosen wave still waits: no offer");
  assert.equal(nextOpenWave([wave("C1", 1), wave("C2", 0)], wave("C2", 0), [{ id: "x", groupId: "C1", verdict: null }], () => false)?.groupId, "C1", "wraps");
});

test("BL-162 AC-UX-06: a stage's failed checks come before the passed ones, each group in the validator's order", async () => {
  const { splitChecks } = await import("./plan-review-screen");
  const checks = [
    { id: "held", pass: true },
    { id: "style", pass: false },
    { id: "loop", pass: true },
    { id: "ring", pass: false },
  ];
  const { failed, passed } = splitChecks(checks);
  assert.deepEqual(failed.map((c) => c.id), ["style", "ring"]);
  assert.deepEqual(passed.map((c) => c.id), ["held", "loop"]);
  assert.deepEqual(splitChecks([]), { failed: [], passed: [] });
});

test("BL-162 AC-UX-07: the wave picker shows waves with a waiting track and the chosen one; reviewed ones on request", async () => {
  const { pickerWaves } = await import("./plan-review-screen");
  const wave = (groupId: string, passed: number, rejected: number) => ({ groupId, title: `${groupId} long title`, total: 5, reviewed: 5 - passed - rejected, waitingPassed: passed, waitingRejected: rejected, accepted: 0, rejected: 0, overridesValidator: 0 });
  // C1 and C2 are fully reviewed, C3 waits only on a validator-rejected track, C4 waits on a passed one.
  const waves = [wave("C1", 0, 0), wave("C2", 0, 0), wave("C3", 0, 1), wave("C4", 2, 0)];
  assert.deepEqual(pickerWaves(waves, null, false), { shown: [waves[2], waves[3]], reviewed: 2 });
  assert.deepEqual(pickerWaves(waves, "C1", false).shown.map((w) => w.groupId), ["C1", "C3", "C4"], "the chosen wave stays, in plan order");
  assert.deepEqual(pickerWaves(waves, null, true).shown.map((w) => w.groupId), ["C1", "C2", "C3", "C4"]);
  assert.deepEqual(pickerWaves([], null, false), { shown: [], reviewed: 0 });
});

// -- BL-173 (PLAN_RECHECKS_PLAN.md §2.8, AC-RC-13): re-checks on the review screen ---------------------------------------------

const stageRow = (stageId: string, result: "done" | "accepted" | "rejected", metrics: Record<string, number> = {}) => ({ stageId, itemKey: "C14/V04", attemptRef: "job:8c4a", result, reportedBy: "factory" as const, note: null, rating: null, reasons: [], markers: [], auditionFile: "R/C14/V04_s1811.mp3", checks: [], metrics, referenceIds: [], at: "2026-10-09T08:00:00.000Z" });

test("BL-173: K keeps the verdict (a re-check's question); the other keys are unchanged", () => {
  assert.equal(reviewKeyAction("k"), "keep");
  assert.equal(reviewKeyAction("K"), "keep");
  assert.equal(reviewKeyAction("a"), "accept");
});

test("BL-173: a revision plays at its own loudness (never the original's); Before keeps the original's; a question plays at the attempt's", () => {
  const stages = [stageRow("postprocess", "done"), stageRow("validate", "accepted", { lufs: -14 })];
  const revisionRow = { ...stageRow("~recheck", "done", { lufs: -16.2 }) };
  assert.equal(playedLufs({ stages: [...stages, revisionRow], recheck: { kind: "revision", metrics: { lufs: -16.2 } } }), -16.2);
  assert.equal(playedLufs({ stages, recheck: { kind: "revision", metrics: {} } }), null, "no LUFS for the fixed file: measured, not the original's -14");
  assert.equal(playedLufs({ stages, recheck: { kind: "question", metrics: {} } }), -14);
  assert.equal(beforeLufs({ stages: [...stages, revisionRow] }), -14, "Before is the attempt itself, without the revision's row");
});

test("BL-173: a re-check's spots become question ranges, labelled with their note or the fallback", () => {
  assert.deepEqual(recheckMarkers({ markers: [{ start: 25, end: 35, note: null }, { start: 40, end: null, note: "voice?" }] }, "question"), [
    { start: 25, end: 35, label: "question", tone: "question" },
    { start: 40, end: null, label: "voice?", tone: "question" },
  ]);
  assert.deepEqual(recheckMarkers(undefined, "question"), []);
});

test("BL-173: another computer's open re-checks become entries with the attempt's rows, the revision's row last; an answer sent from here counts as given", () => {
  const shared = {
    recheckId: "C14-XL_V04_s1811__r1",
    itemKey: "C14/V04",
    attemptRef: "job:8c4a",
    kind: "revision" as const,
    title: "резкость",
    note: "fixed 2-3 kHz",
    auditionFile: "R/C14/V04_s1811__r1.mp3",
    markers: [],
    checks: [],
    metrics: { lufs: -16.2 },
    previousVerdict: { result: "rejected" as const, rating: null, reasons: [], markers: [], note: "too sharp", device: "MAC", at: "2026-10-09T20:00:00.000Z" },
    openedAt: "2026-10-10T12:00:00.000Z",
    extraStage: stageRow("~recheck", "done", { lufs: -16.2 }),
  };
  const reviewEntry = { itemKey: "C14/V04", groupId: "C14", attemptRef: "job:8c4a", jobId: "8c4a", seed: 1811, params: {}, stages: [stageRow("postprocess", "done"), stageRow("validate", "accepted")], verdict: { ...stageRow("owner_review", "rejected"), reportedBy: "owner" as const }, playable: true };
  // As the peers route answers: the shared entries carry no `validator` (the reader derives it from the stages).
  const data = {
    devices: [{ deviceId: "mac-1", hostname: "MAC", plans: [{ planId: "R-0001-S1-music", review: [reviewEntry], itemParams: { "C14/V04": { prompt: "koto" } }, items: [{ itemKey: "C14/V04", groupId: "C14" }], rechecks: [shared] }] }],
    outgoing: [],
  } as unknown as Parameters<typeof peerRecheckEntries>[0];
  const source = { deviceId: "mac-1", hostname: "MAC" };
  const [open] = peerRecheckEntries(data, source, "R-0001-S1-music");
  assert.deepEqual(
    [open.recheck.recheckId, open.recheck.status, open.groupId, open.stages.map((s) => s.stageId), open.verdict, open.validator, open.params],
    ["C14-XL_V04_s1811__r1", "open", "C14", ["postprocess", "validate", "~recheck"], null, "passed", { prompt: "koto" }]
  );
  data.outgoing.push({ planId: "R-0001-S1-music", ownerDeviceId: "mac-1", itemKey: "C14/V04", attemptRef: "job:8c4a", result: "accepted", rating: 8, at: "2026-10-10T12:10:00.000Z", recheckId: "C14-XL_V04_s1811__r1" });
  const [sent] = peerRecheckEntries(data, source, "R-0001-S1-music");
  assert.deepEqual([sent.verdict?.result, sent.verdict?.note, sent.pendingKept ?? false], ["accepted", "sent, waiting for MAC", false]);
  // A kept answer sent from here is a note: the track itself keeps showing the verdict that device holds.
  data.outgoing[0] = { ...data.outgoing[0], kept: true, result: "rejected" };
  assert.equal(peerRecheckEntries(data, source, "R-0001-S1-music")[0].pendingKept, true);
  assert.equal(peerQueue(data, source, "R-0001-S1-music")[0].verdict?.note, null, "no 'sent, waiting' on the track for a kept answer");
  assert.deepEqual(peerRecheckEntries({ ...data, devices: [{ ...data.devices[0], plans: [{ ...data.devices[0].plans[0], rechecks: undefined }] }] }, source, "R-0001-S1-music"), [], "a version 3 report has none");
});

test("BL-173 review round 1: a question on an accepted revision plays at that revision's loudness or is measured; a queue track playing one is measured; Before of a later revision is the earlier one's", () => {
  const original = [stageRow("postprocess", "done"), stageRow("validate", "accepted", { lufs: -14 })];
  assert.equal(playedLufs({ stages: [...original, stageRow("~recheck", "done", { lufs: -15.5 })], recheck: { kind: "question", metrics: {} } }), -15.5);
  assert.equal(playedLufs({ stages: [...original, stageRow("~recheck", "done")], recheck: { kind: "question", metrics: {} } }), null, "the revision has no LUFS: measured, not the original's -14");
  assert.equal(playedLufs({ stages: original, currentFile: "R/C14/V04_s1811__r1.mp3" }), null, "a queue track that plays an accepted revision");
  assert.equal(playedLufs({ stages: original }), -14);
  assert.equal(beforeLufs({ stages: [...original, stageRow("~recheck", "done")], beforeRow: { metrics: { lufs: -15.5 } } }), -15.5);
  assert.equal(beforeLufs({ stages: [...original, stageRow("~recheck", "done")], beforeRow: { metrics: {} } }), null);
});

test("BL-173: the picker shows the re-checks while any is listed or chosen, counting the ones still open here", () => {
  assert.deepEqual(recheckPickerOption([{ verdict: null }, { verdict: { result: "accepted" } }], null), { shown: true, open: 1 });
  assert.deepEqual(recheckPickerOption([], null), { shown: false, open: 0 });
  assert.deepEqual(recheckPickerOption([], "~rechecks"), { shown: true, open: 0 });
});

test("BL-173: a history line names a re-check's answer, and a kept answer reads as a note", () => {
  const at = "2026-10-10T12:30:00.000Z";
  const verdict = historyLineOf(t, { result: "accepted", rating: 9, note: null, device: "WIN", at, recheckId: "C14-XL_V04_s1811__r1" });
  assert.match(verdict.text, /^WIN · .* · Accepted 9\/10$/i);
  assert.equal(verdict.recheck, "re-check C14-XL_V04_s1811__r1");
  const kept = historyLineOf(t, { result: "accepted", rating: null, note: "no voice heard", device: "MAC", at, recheckId: "q1", kept: true });
  assert.match(kept.text, /^MAC · .* · verdict kept, note only · no voice heard$/);
  assert.equal(historyLineOf(t, { result: "rejected", rating: null, note: null, device: "MAC", at }).recheck, null);
});

test("BL-173 review round 2: a real stage named like the revision row is not one -- only the '~recheck' row is", () => {
  const stages = [stageRow("postprocess", "done"), stageRow("recheck", "done", { lufs: -13 })];
  assert.equal(playedLufs({ stages, recheck: { kind: "question", metrics: {} } }), -13, "a plan stage called 'recheck' is the validator's own row");
  assert.equal(beforeLufs({ stages }), -13);
});
