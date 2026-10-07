import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { GenerationPlan } from "./contracts";
import { planProgress, type PlanJobRow, type PlanSessionRow } from "./progress";

// AC-GP-11 and AC-GP-16 (GENERATION_PLANS_PLAN.md §4). Expected numbers are worked out by hand from the rules below.

const plan: GenerationPlan = {
  planId: "p",
  title: "T",
  channelId: "UC1",
  owner: "factory",
  status: "active",
  budget: { usd: 1, gpuMinutes: null },
  note: null,
  revision: 1,
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
  closedAt: null,
  stages: [{ stageId: "generate", title: "G", kind: "in_app" }],
  groups: [],
  items: [{ itemKey: "A/1", groupId: null, templateLabel: null, templateId: "t", variant: null, targetCount: 10, mode: "fixed", maxAttempts: null, params: {}, seeds: [] }],
};

const t = (iso: string) => new Date(iso);
const session = (over: Partial<PlanSessionRow>): PlanSessionRow => ({ id: "s", status: "done", gpuTypeId: "RTX 4090", costPerHr: 0.6, startedAt: null, readyAt: null, stoppedAt: null, secondsUsed: null, usdCharged: null, stopReason: null, ...over });
const job = (id: string, sessionId: string, seconds: number): PlanJobRow => ({
  id,
  sessionId,
  stageId: "generate",
  itemKey: "A/1",
  seed: null,
  status: "done",
  error: null,
  createdAt: t("2026-10-07T09:00:00Z"),
  submittedAt: t("2026-10-07T09:00:00Z"),
  finishedAt: new Date(t("2026-10-07T09:00:00Z").getTime() + seconds * 1000),
});

test("AC-GP-11: spend = final usdCharged of finished sessions + live cost of running ones; warnings exactly at 80 % and 100 %", () => {
  const now = t("2026-10-07T10:00:00Z");
  const finished = session({ id: "s1", status: "done", usdCharged: 0.5, secondsUsed: 3000 });
  // Running for 30 min at $0.60/h = $0.30, no usdCharged yet.
  const live = session({ id: "s2", status: "running", startedAt: t("2026-10-07T09:30:00Z") });
  const p = planProgress(plan, [], [], [finished, live], now);
  assert.equal(p.spend.usd, 0.8);
  assert.equal(p.spend.gpuMinutes, 80, "50 min billed + 30 min live");
  assert.deepEqual(p.budget, { usd: 1, usedShare: 0.8, warnings: ["80"] });
  assert.deepEqual(p.spend.sessions.map((s) => [s.sessionId, s.usd, s.final]), [["s1", 0.5, true], ["s2", 0.3, false]]);
  assert.deepEqual(planProgress(plan, [], [], [finished], now).budget.warnings, [], "50 % -> no warning");
  assert.deepEqual(planProgress(plan, [], [], [finished, session({ id: "s3", usdCharged: 0.5 })], now).budget.warnings, ["80", "100"]);
  assert.deepEqual(planProgress({ ...plan, budget: { usd: null, gpuMinutes: null } }, [], [], [finished], now).budget, { usd: null, usedShare: null, warnings: [] });
});

test("AC-GP-11: ETA uses only finished jobs on the current session's GPU type, and is null below 3 of them", () => {
  const now = t("2026-10-07T10:00:00Z");
  const l4 = session({ id: "l4", gpuTypeId: "NVIDIA L4", usdCharged: 0.1 });
  const r4090 = session({ id: "4090", status: "running", gpuTypeId: "RTX 4090", startedAt: t("2026-10-07T09:50:00Z") });
  // Two 4090 jobs (90 s, 100 s) and three L4 jobs (160 s): the current GPU is the 4090 -> 2 samples -> null.
  const jobs = [job("a", "4090", 90), job("b", "4090", 100), job("c", "l4", 160), job("d", "l4", 160), job("e", "l4", 160)];
  const two = planProgress(plan, jobs, [], [l4, r4090], now).eta;
  assert.deepEqual(two, { seconds: null, gpuTypeId: "RTX 4090", samples: 2 });
  // A third 4090 job (95 s): mean 95 s; 10 targeted - 6 done = 4 missing -> 380 s.
  const three = planProgress(plan, [...jobs, job("f", "4090", 95)], [], [l4, r4090], now).eta;
  assert.deepEqual(three, { seconds: 380, gpuTypeId: "RTX 4090", samples: 3 });
});

test("AC-GP-16: media-generation imports nothing from generation-plans", async () => {
  const dir = "src/lib/media-generation";
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  await walk(dir);
  assert.ok(files.length > 10);
  for (const file of files) assert.equal((await readFile(file, "utf8")).includes("generation-plans"), false, file);
});

// Review A1: stored times have one-second resolution, so `since` is inclusive of its second and the page is the OLDEST
// events after it, with a cursor that never skips one.
test("review A1: events are paged oldest first from the since second (inclusive); the cursor never skips an event", async () => {
  const { planEvents } = await import("./progress");
  const ev = (iso: string, n: number) => ({ at: iso, kind: "group_note", actor: "owner", details: { n } });
  const recorded = [ev("2026-10-07T10:00:00.000Z", 1), ev("2026-10-07T10:00:01.000Z", 2), ev("2026-10-07T10:00:02.000Z", 3), ev("2026-10-07T10:00:03.000Z", 4)];
  // A cursor taken at 10:00:01.400 must still deliver the event stored as 10:00:01.000 (it may have happened at .800).
  const page = planEvents([], [], [], recorded, new Date("2026-10-07T10:00:01.400Z"));
  assert.deepEqual(page.events.map((e) => e.details.n), [2, 3, 4]);
  assert.equal(page.more, false);
  const first = planEvents([], [], [], recorded, null, 2);
  assert.deepEqual([first.events.map((e) => e.details.n), first.more, first.cursor], [[1, 2], true, "2026-10-07T10:00:01.000Z"]);
  const second = planEvents([], [], [], recorded, new Date(first.cursor as string), 2);
  assert.deepEqual(second.events.map((e) => e.details.n), [2, 3], "event 2 repeats; nothing is lost");
});

// AC-GP3-01 (GENERATION_PLANS_PHASE_3_PLAN.md): notices follow the counts.
test("AC-GP3-01: a stage is complete when its count reaches the target; the plan is complete when nothing is missing or open", async () => {
  const { planProgress } = await import("./progress");
  const small: GenerationPlan = { ...plan, budget: { usd: 1, gpuMinutes: null }, items: [{ ...plan.items[0], targetCount: 2 }] };
  const now = t("2026-10-07T10:00:00Z");
  const running: PlanJobRow = { ...job("a", "s", 90), status: "generating", finishedAt: null };
  const kinds = (jobs: PlanJobRow[], sessions: PlanSessionRow[] = []) => planProgress(small, jobs, [], sessions, now).notices.map((n) => n.kind);
  assert.deepEqual(kinds([running]), []);
  assert.deepEqual(kinds([job("a", "s", 90), running]), []);
  assert.deepEqual(kinds([job("a", "s", 90), job("b", "s", 90)]), ["stage_complete", "plan_complete"]);
  assert.deepEqual(kinds([job("a", "s", 90), job("b", "s", 90)], [session({ id: "s", usdCharged: 0.85 })]), ["stage_complete", "budget_80", "plan_complete"]);
});
