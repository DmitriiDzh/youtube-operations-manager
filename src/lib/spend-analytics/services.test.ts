import assert from "node:assert/strict";
import test from "node:test";
import type { CostRun } from "@/lib/video-costs";
import type { SpendFacts, SpendFilter, SpendInputs } from "./contracts";
import { buildHistory, buildSummary, lastDays } from "./services";

// SERVERS_ANALYTICS_PLAN.md AC-SA-01..07. Every expected value below was worked out by hand from the fixture, not by running the code.

const NOW = new Date("2026-10-24T12:00:00Z");
const T = "UC_TROPICO";
const J = "UC_JAPAN";

function run(partial: Partial<CostRun> & Pick<CostRun, "runId" | "source" | "kind" | "usd" | "createdAt">): CostRun {
  return {
    channelId: T,
    video: null,
    label: null,
    mediaKind: null,
    storyboardId: null,
    storyboardVersion: null,
    segmentId: null,
    planId: null,
    status: "done",
    basis: "measured",
    overheadUsd: null,
    gpuSeconds: null,
    finishedAt: null,
    deviceId: "mac",
    hostName: "Mac",
    thisComputer: true,
    result: "test",
    estimate: false,
    ...partial,
  } as CostRun;
}

const RUNS: CostRun[] = [
  run({ runId: "runpod:J1", source: "runpod", kind: "job", video: "V61", label: "LTX", mediaKind: "video", usd: 0.3, overheadUsd: 0.05, gpuSeconds: 600, createdAt: "2026-10-24T09:00:00Z" }),
  run({ runId: "runpod:J2", source: "runpod", kind: "job", video: "V61", label: "LTX", mediaKind: "video", status: "failed", usd: 0.1, overheadUsd: 0.02, gpuSeconds: 100, createdAt: "2026-10-24T09:10:00Z" }),
  run({ runId: "session:S2", source: "runpod", kind: "session", usd: 0.07, overheadUsd: 0.07, gpuSeconds: 0, createdAt: "2026-10-23T15:00:00Z" }),
  run({ runId: "session:S3", source: "runpod", kind: "session", usd: 0.04, overheadUsd: 0.04, gpuSeconds: 0, createdAt: "2026-10-22T10:00:00Z" }),
  run({ runId: "gemini:G1", source: "gemini", kind: "job", label: "Nano Banana", mediaKind: "image", usd: 0.06, createdAt: "2026-10-23T17:00:00Z" }),
  run({ runId: "gemini:G2", source: "gemini", kind: "job", channelId: J, label: "Nano Banana", mediaKind: "image", status: "failed", usd: 0.4, createdAt: "2026-10-21T08:00:00Z" }),
  run({ runId: "runpod:P1", source: "runpod", kind: "job", video: "V62", label: "ACE", mediaKind: "audio", usd: 0.2, overheadUsd: 0.03, gpuSeconds: 300, createdAt: "2026-10-20T08:00:00Z", deviceId: "win", hostName: "DESKTOP", thisComputer: false }),
  run({ runId: "gemini:G3", source: "gemini", kind: "job", label: "Nano Banana", mediaKind: "image", usd: 1, createdAt: "2026-10-14T08:00:00Z" }),
  run({ runId: "gemini:G4", source: "gemini", kind: "job", label: "Nano Banana", mediaKind: "image", usd: 5, createdAt: "2026-10-01T08:00:00Z" }),
];

const at = (iso: string) => new Date(iso);
const FACTS: SpendFacts = {
  sessions: new Map([
    ["S1", { id: "S1", channelId: T, status: "done", requestedBy: "factory", gpuTypeId: "RTX 4090", secondsUsed: 900, usdCharged: 0.4, stopReason: null, error: null, createdAt: at("2026-10-24T08:55:00Z"), stoppedAt: null }],
    ["S2", { id: "S2", channelId: T, status: "failed", requestedBy: "factory", gpuTypeId: "RTX PRO 4500", secondsUsed: 370, usdCharged: 0.07, stopReason: null, error: "media_container_stuck: the container did not start", createdAt: at("2026-10-23T15:00:00Z"), stoppedAt: null }],
    ["S3", { id: "S3", channelId: T, status: "done", requestedBy: "operator", gpuTypeId: "RTX 4090", secondsUsed: 240, usdCharged: 0.04, stopReason: null, error: null, createdAt: at("2026-10-22T10:00:00Z"), stoppedAt: null }],
  ]),
  jobs: new Map([
    ["J1", { id: "J1", sessionId: "S1", createdBy: "factory", outputsJson: JSON.stringify([{ kind: "images", filename: "a.png" }, { kind: "gifs", filename: "b.mp4" }]), error: null }],
    ["J2", { id: "J2", sessionId: "S1", createdBy: "factory", outputsJson: null, error: "boom" }],
  ]),
  gemini: new Map([
    ["G1", { jobId: "G1", createdBy: "factory", outputsJson: JSON.stringify([{ kind: "image", mimeType: "image/jpeg", path: "x.jpg" }]), errorCode: null }],
    ["G2", { jobId: "G2", createdBy: "agent", outputsJson: null, errorCode: "gemini_payment_required" }],
    ["G3", { jobId: "G3", createdBy: "factory", outputsJson: null, errorCode: null }],
    ["G4", { jobId: "G4", createdBy: "factory", outputsJson: null, errorCode: null }],
  ]),
};

const INPUTS: SpendInputs = { runs: RUNS, computers: [], facts: FACTS };
const WEEK: SpendFilter = { days: 7, channelId: null, device: "all", who: "all", tz: "UTC" };

test("the last 7 days in a time zone end today", () => {
  assert.deepEqual(lastDays(NOW, 7, "UTC"), ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
  // In Tokyo it is already the evening of the 24th too; at 23:30 UTC it is the 25th there.
  assert.equal(lastDays(new Date("2026-10-24T23:30:00Z"), 1, "Asia/Tokyo")[0], "2026-10-25");
});

test("AC-SA-01/02/06: totals, results, cost per result and the previous period", () => {
  const s = buildSummary(INPUTS, WEEK, NOW);
  assert.deepEqual(s.totals, { totalUsd: 1.17, runpodUsd: 0.71, geminiUsd: 0.46, previousTotalUsd: 1, estimated: false });
  assert.equal(s.results.done, 3);
  assert.equal(s.results.failed, 2);
  assert.deepEqual(s.results.byKind, { image: { usd: 0.06, count: 1 }, video: { usd: 0.3, count: 1 }, audio: { usd: 0.2, count: 1 }, other: { usd: 0, count: 0 } });
  assert.equal(s.costPerResultUsd, 0.39);
  assert.deepEqual(s.gpu, { workHours: 0.3, paidHours: 0.4 });
  assert.deepEqual(s.period, { days: 7, firstDay: "2026-10-18", lastDay: "2026-10-24" });
});

test("AC-SA-03: losses -- idle, failed jobs, failed Gemini, failed starts", () => {
  const s = buildSummary(INPUTS, WEEK, NOW);
  assert.deepEqual(s.losses, {
    idle: { usd: 0.12, count: 1 },
    failedJobs: { usd: 0.1, count: 1 },
    failedGemini: { usd: 0.4, count: 1 },
    failedStarts: { usd: 0.07, count: 1 },
    totalUsd: 0.69,
  });
});

test("AC-SA-04: one bucket per day, split into GPU work, GPU idle and Gemini", () => {
  const s = buildSummary(INPUTS, WEEK, NOW);
  assert.deepEqual(s.daily, [
    { day: "2026-10-18", runpodWorkUsd: 0, runpodIdleUsd: 0, geminiUsd: 0 },
    { day: "2026-10-19", runpodWorkUsd: 0, runpodIdleUsd: 0, geminiUsd: 0 },
    { day: "2026-10-20", runpodWorkUsd: 0.17, runpodIdleUsd: 0.03, geminiUsd: 0 },
    { day: "2026-10-21", runpodWorkUsd: 0, runpodIdleUsd: 0, geminiUsd: 0.4 },
    { day: "2026-10-22", runpodWorkUsd: 0, runpodIdleUsd: 0.04, geminiUsd: 0 },
    { day: "2026-10-23", runpodWorkUsd: 0, runpodIdleUsd: 0.07, geminiUsd: 0.06 },
    { day: "2026-10-24", runpodWorkUsd: 0.33, runpodIdleUsd: 0.07, geminiUsd: 0 },
  ]);
});

test("AC-SA-05: breakdowns, largest first", () => {
  const s = buildSummary(INPUTS, WEEK, NOW);
  assert.deepEqual(
    s.byLabel.map((r) => [r.label, r.source, r.runs, r.usd]),
    [
      ["Nano Banana", "gemini", 2, 0.46],
      ["LTX", "runpod", 2, 0.4],
      ["ACE", "runpod", 1, 0.2],
    ]
  );
  assert.deepEqual(s.byVideo, {
    videos: [
      { channelId: T, video: "V61", runs: 2, usd: 0.4 },
      { channelId: T, video: "V62", runs: 1, usd: 0.2 },
    ],
    unlinkedUsd: 0.57,
  });
  assert.deepEqual(s.byChannel, [
    { channelId: T, usd: 0.77 },
    { channelId: J, usd: 0.4 },
  ]);
  assert.deepEqual(s.byWho, [
    { who: "factory", usd: 0.53 },
    { who: "agent", usd: 0.4 },
    { who: "other_computer", usd: 0.2 },
    { who: "owner", usd: 0.04 },
  ]);
  assert.deepEqual(s.byGpu, [
    { gpuTypeId: "RTX 4090", sessions: 2, usd: 0.44 },
    { gpuTypeId: "RTX PRO 4500", sessions: 1, usd: 0.07 },
  ]);
});

test("AC-SA-06: filters -- channel, this computer, who; everything spans all days", () => {
  assert.equal(buildSummary(INPUTS, { ...WEEK, channelId: J }, NOW).totals.totalUsd, 0.4);
  assert.equal(buildSummary(INPUTS, { ...WEEK, device: "this" }, NOW).totals.totalUsd, 0.97);
  assert.equal(buildSummary(INPUTS, { ...WEEK, who: "owner" }, NOW).totals.totalUsd, 0.04);
  const all = buildSummary(INPUTS, { ...WEEK, days: null }, NOW);
  assert.equal(all.totals.totalUsd, 7.17);
  assert.equal(all.totals.previousTotalUsd, null);
  assert.equal(all.period.firstDay, "2026-10-01");
  assert.equal(all.daily.length, 24);
});

test("AC-SA-07: history -- sessions with their jobs, Gemini jobs and the other computer's runs, newest first", () => {
  const page = buildHistory(INPUTS, WEEK, { kind: "all", errorsOnly: false, cursor: null }, NOW);
  assert.deepEqual(
    page.rows.map((r) => [r.type, r.id]),
    [
      ["session", "S1"],
      ["gemini", "G1"],
      ["session", "S2"],
      ["session", "S3"],
      ["gemini", "G2"],
      ["other_computer", "runpod:P1"],
    ]
  );
  const s1 = page.rows[0];
  assert.ok(s1.type === "session");
  assert.equal(s1.usd, 0.4);
  assert.equal(s1.idleUsd, 0.07);
  assert.equal(s1.results, 1);
  assert.deepEqual(s1.videos, ["V61"]);
  assert.equal(s1.gpuTypeId, "RTX 4090");
  assert.deepEqual(s1.jobs.map((j) => [j.jobId, j.status, j.usd, j.images]), [
    ["J1", "done", 0.3, 1],
    ["J2", "failed", 0.1, 0],
  ]);
  const s2 = page.rows[2];
  assert.ok(s2.type === "session");
  assert.equal(s2.error?.code, "media_container_stuck");
  assert.equal(page.total, 6);
  assert.equal(page.nextCursor, null);
});

test("AC-SA-07: history filters -- errors only, Gemini only", () => {
  const errors = buildHistory(INPUTS, WEEK, { kind: "all", errorsOnly: true, cursor: null }, NOW);
  assert.deepEqual(errors.rows.map((r) => r.id), ["S1", "S2", "G2"]);
  const gemini = buildHistory(INPUTS, WEEK, { kind: "gemini", errorsOnly: false, cursor: null }, NOW);
  assert.deepEqual(gemini.rows.map((r) => r.id), ["G1", "G2"]);
});

test("AC-SA-04/07: a day picked on the chart narrows the history to that day", () => {
  const page = buildHistory(INPUTS, WEEK, { kind: "all", errorsOnly: false, cursor: null, day: "2026-10-23" }, NOW);
  assert.deepEqual(page.rows.map((r) => r.id), ["G1", "S2"]);
});

test("review: a Gemini job started in the Web UI (createdBy owner) counts as the owner's", () => {
  const facts: SpendFacts = { ...FACTS, gemini: new Map([...FACTS.gemini, ["G1", { jobId: "G1", createdBy: "owner", outputsJson: null, errorCode: null }]]) };
  const s = buildSummary({ ...INPUTS, facts }, { ...WEEK, who: "owner" }, NOW);
  assert.equal(s.totals.totalUsd, 0.1); // S3 0.04 (operator) + G1 0.06 (owner)
  const page = buildHistory({ ...INPUTS, facts }, WEEK, { kind: "gemini", errorsOnly: false, cursor: null }, NOW);
  const g1 = page.rows.find((r) => r.id === "G1");
  assert.ok(g1 && g1.type === "gemini" && g1.who === "owner");
});
