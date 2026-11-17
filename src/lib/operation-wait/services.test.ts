import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { clampTimeoutSeconds, createOperationWait, exitCodeFor, WaitNotFoundError, type WaitObservation, type WaitPort, type WaitTarget } from "./index";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §6 "Core"): a fake clock and a scripted reader. Expected values are written from the
// plan (§3.2, AC-WT-01/04/05/07), never read back from the code.

function harness(options: { reads: Array<WaitObservation | Error>; target?: WaitTarget; restarting?: boolean; abortAfterSleeps?: number }) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const controller = new AbortController();
  let calls = 0;
  const port: WaitPort = async () => {
    const next = options.reads[Math.min(calls, options.reads.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const wait = createOperationWait({
    ports: { [options.target ?? "media_job"]: port },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      if (options.abortAfterSleeps !== undefined && sleeps.length >= options.abortAfterSleeps) controller.abort();
    },
    shutdownSignal: () => controller.signal,
    restarting: async () => options.restarting ?? false,
    pollMs: { media_job: 5_000, restart: 5_000, upload: 10_000, storyboard_review: 15_000 },
  });
  return { wait, sleeps, calls: () => calls };
}

const running: WaitObservation = { id: "j1", status: "generating", final: false, outcome: "still_running", snapshot: { jobId: "j1" } };
const done: WaitObservation = { id: "j1", status: "done", final: true, outcome: "succeeded", snapshot: { jobId: "j1", outputs: ["a.png"] } };

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error), `a DomainError, got ${String(error)}`);
    return { code: error.code, details: error.details };
  }
  assert.fail("expected a refusal");
}

test("AC-WT-04: a target already final returns at the first read, with no sleep", async () => {
  const h = harness({ reads: [done] });
  const result = await h.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null });
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.calls(), 1);
  assert.deepEqual(result, { target: "media_job", id: "j1", final: true, outcome: "succeeded", status: "done", snapshot: { jobId: "j1", outputs: ["a.png"] }, waitedSeconds: 0 });
});

test("AC-WT-01: final on the third read -> one result after two polls of 5 s, waitedSeconds 10, no hint", async () => {
  const h = harness({ reads: [running, running, done] });
  const result = await h.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null });
  assert.deepEqual(h.sleeps, [5_000, 5_000]);
  assert.equal(result.final, true);
  assert.equal(result.waitedSeconds, 10);
  assert.equal(result.nextCallHint, undefined);
});

test("AC-WT-05: past timeoutSeconds the result is final:false / still_running with the last status, never an error", async () => {
  const h = harness({ reads: [running] });
  const result = await h.wait.waitFor({ target: "media_job", id: "j1", timeoutSeconds: 12 }, { channelId: null });
  // reads at 0, 5, 10 and 12 s (the last poll is cut to the deadline)
  assert.deepEqual(h.sleeps, [5_000, 5_000, 2_000]);
  assert.equal(h.calls(), 4);
  assert.equal(result.final, false);
  assert.equal(result.outcome, "still_running");
  assert.equal(result.status, "generating");
  assert.equal(result.waitedSeconds, 12);
  assert.match(result.nextCallHint ?? "", /npm --prefix <app folder> run --silent wait --/);
});

test("AC-WT-05: timeoutSeconds defaults to 50 and is clamped to 1..240", async () => {
  for (const [given, seconds] of [[undefined, 50], [600, 240], [240, 240], [0, 1], [-5, 1], [1, 1]] as const) {
    const h = harness({ reads: [running] });
    const result = await h.wait.waitFor({ target: "media_job", id: "j1", ...(given === undefined ? {} : { timeoutSeconds: given }) }, { channelId: null });
    assert.equal(h.sleeps.reduce((a, b) => a + b, 0), seconds * 1000, `timeoutSeconds ${given}`);
    assert.equal(result.waitedSeconds, seconds);
  }
  assert.equal(clampTimeoutSeconds(undefined), 50);
  assert.equal(clampTimeoutSeconds(Number.NaN), 50);
  assert.equal(clampTimeoutSeconds(239.5), 239.5);
});

test("AC-WT-07: the process's stop signal ends a blocked wait at once with server_stopping (final:false)", async () => {
  const h = harness({ reads: [running], abortAfterSleeps: 1 });
  const result = await h.wait.waitFor({ target: "media_job", id: "j1", timeoutSeconds: 240 }, { channelId: null });
  assert.equal(h.sleeps.length, 1);
  assert.equal(result.final, false);
  assert.equal(result.outcome, "server_stopping");
  assert.equal(result.status, "generating");
});

test("AC-WT-07: a restart under way ends a wait on any other target within one poll (restarting); a restart wait keeps waiting", async () => {
  const h = harness({ reads: [running], restarting: true });
  const result = await h.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null });
  assert.deepEqual(h.sleeps, []);
  assert.equal(result.outcome, "restarting");
  assert.equal(result.final, false);

  const restarting: WaitObservation = { id: "r1", status: "restarting", final: false, outcome: "still_running", snapshot: {} };
  const r = harness({ reads: [restarting], target: "restart", restarting: true });
  const own = await r.wait.waitFor({ target: "restart", id: "r1", timeoutSeconds: 10 }, { channelId: null });
  assert.equal(own.outcome, "still_running");
  assert.deepEqual(r.sleeps, [5_000, 5_000]);
});

test("plan §3.2: blocked (an upload paused for the owner) and not_in_review end the call at once, final:false", async () => {
  const blocked: WaitObservation = { id: "u1", status: "paused", final: false, outcome: "blocked", snapshot: { pausedReason: "auth" } };
  const h = harness({ reads: [blocked], target: "upload" });
  const result = await h.wait.waitFor({ target: "upload", id: "u1" }, { channelId: null });
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual([result.final, result.outcome], [false, "blocked"]);
});

test("plan §3.2: one failed read is retried at the next poll; three in a row answer target_unavailable", async () => {
  const once = harness({ reads: [new Error("SQLITE_BUSY"), done] });
  assert.equal((await once.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null })).outcome, "succeeded");
  assert.deepEqual(once.sleeps, [5_000]);

  const thrice = harness({ reads: [running, new Error("a"), new Error("b"), new Error("c"), done] });
  assert.deepEqual(await refusal(thrice.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null })), {
    code: "target_unavailable",
    details: { target: "media_job", id: "j1" },
  });
  assert.equal(thrice.calls(), 4);
});

test("a missing id answers not_found at once, with only the target and the id; gone after being seen is a failed read", async () => {
  const missing = harness({ reads: [new WaitNotFoundError()] });
  assert.deepEqual(await refusal(missing.wait.waitFor({ target: "media_job", id: "nope" }, { channelId: "UC_A" })), { code: "not_found", details: { target: "media_job", id: "nope" } });
  assert.deepEqual(missing.sleeps, []);

  const vanished = harness({ reads: [running, new WaitNotFoundError(), done] });
  assert.equal((await vanished.wait.waitFor({ target: "media_job", id: "j1" }, { channelId: null })).outcome, "succeeded");
});

test("input: unknown target, wrong until, missing channelId / storyboardId, bad timeoutSeconds -> invalid_request; a disabled target -> target_unavailable", async () => {
  const h = harness({ reads: [done] });
  const scope = { channelId: null };
  for (const bad of [
    { target: "weekly_build", id: "x" },
    { target: "media_job" },
    { target: "media_job", id: "" },
    { target: "media_job", id: "j1", until: "ready" },
    { target: "media_session", id: "s1", until: "claimed" },
    { target: "translation_request", id: "r1" },
    { target: "storyboard_review", id: "sb1" },
    { target: "storyboard_render", id: "rd1", channelId: "UC_A" },
    { target: "media_job", id: "j1", timeoutSeconds: "60" },
  ]) {
    assert.equal((await refusal(h.wait.waitFor(bad, scope))).code, "invalid_request", JSON.stringify(bad));
  }
  assert.equal((await refusal(h.wait.waitFor({ target: "gemini_job", id: "gm_1" }, scope))).code, "target_unavailable");
});

test("exit codes (plan §3.3): 0 succeeded; 1 failed, partly_failed, cancelled, rejected, changes_requested, expired; 2 the rest", () => {
  assert.equal(exitCodeFor("succeeded"), 0);
  for (const outcome of ["failed", "partly_failed", "cancelled", "rejected", "changes_requested", "expired"] as const) assert.equal(exitCodeFor(outcome), 1, outcome);
  for (const outcome of ["still_running", "blocked", "not_in_review", "restarting", "server_stopping"] as const) assert.equal(exitCodeFor(outcome), 2, outcome);
  assert.equal(exitCodeFor(null), 2);
});
