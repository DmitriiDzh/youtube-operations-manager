import assert from "node:assert/strict";
import test from "node:test";
import { formatPlayerTime } from "./media-review-player";
import { createTranslator } from "@/lib/ui-text";
import type { PlanCheck } from "@/lib/generation-plans/contracts";
import { failedChecksOf, filterEntries, findingMarkers, nextWaitingIndex, REVIEW_REASONS, reviewKeyAction } from "./plan-review-screen";

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
