import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createOperationWait, type WaitInput, type WaitScope } from "@/lib/operation-wait";
import { createWaitPorts, type UploadRow, type WaitTargetReads } from "./wait-targets";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md §2, §6 "Ports" / "Scoping"): the status table of plan §2 IS the expected value --
// every listed status of every target is checked as still running, success or failure, by hand from the table (AC-WT-03), and a
// resource of another channel answers byte-for-byte like a missing one (AC-WT-10).

const OPERATOR: WaitScope = { channelId: null };
const WORKER_A: WaitScope = { channelId: "UC_A" };

function uploadRow(over: Partial<UploadRow> = {}): UploadRow {
  return {
    id: "up_1",
    channelId: "UC_A",
    video: "V12",
    status: "queued",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    totalBytes: 1000,
    storedBytes: 250,
    videoId: null,
    publishAt: null,
    errorCode: null,
    createdAt: new Date("2026-11-17T10:00:00Z"),
    finishedAt: null,
    ...over,
  };
}

/** Runs one target through the real wait core over fake reads; a final or ended answer comes back from the first read. */
async function waitOnce(reads: WaitTargetReads, input: WaitInput, scope: WaitScope = OPERATOR) {
  let now = 0;
  const wait = createOperationWait({
    ports: createWaitPorts(reads),
    now: () => now,
    sleep: async (ms) => void (now += ms),
    shutdownSignal: () => new AbortController().signal,
    restarting: async () => false,
  });
  return wait.waitFor({ ...input, timeoutSeconds: 1 }, scope);
}

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error));
    return JSON.stringify({ code: error.code, message: error.message, details: error.details });
  }
  assert.fail("expected an error");
}

const notFoundShape = (target: string, id: string) => JSON.stringify({ code: "not_found", message: `No ${target} with this id on this computer.`, details: { target, id } });

test("AC-WT-03 upload: queued/uploading/processing/finishing and quota/limit pauses run; done/failed/cancelled are final; auth/live-writes pauses are blocked (Q2)", async () => {
  const cases: Array<[Partial<UploadRow>, boolean, string]> = [
    [{ status: "queued" }, false, "still_running"],
    [{ status: "uploading" }, false, "still_running"],
    [{ status: "processing" }, false, "still_running"],
    [{ status: "finishing" }, false, "still_running"],
    [{ status: "paused", pausedReason: "quota_exceeded" }, false, "still_running"],
    [{ status: "paused", pausedReason: "upload_limit" }, false, "still_running"],
    [{ status: "paused", pausedReason: "auth" }, false, "blocked"],
    [{ status: "paused", pausedReason: "live_writes_off" }, false, "blocked"],
    [{ status: "done", videoId: "abcdefghijk" }, true, "succeeded"],
    [{ status: "failed", errorCode: "upload_failed" }, true, "failed"],
    [{ status: "cancelled" }, true, "cancelled"],
  ];
  for (const [over, final, outcome] of cases) {
    const row = uploadRow(over);
    const result = await waitOnce({ upload: { byId: async () => row, latest: async () => null } }, { target: "upload", id: "up_1" });
    assert.deepEqual([result.final, result.outcome, result.status], [final, outcome, over.status], JSON.stringify(over));
  }
  const result = await waitOnce({ upload: { byId: async () => uploadRow(), latest: async () => null } }, { target: "upload", id: "up_1" });
  assert.equal(result.snapshot.progressPercent, 25);
});

test("upload by video code: the newest row of that channel and code; without a channel a code is not found", async () => {
  const asked: Array<[string, string]> = [];
  const reads: WaitTargetReads = {
    upload: {
      byId: async () => null,
      latest: async (channelId, video) => {
        asked.push([channelId, video]);
        return uploadRow({ id: "up_newest", status: "done" });
      },
    },
  };
  const result = await waitOnce(reads, { target: "upload", id: "V12", channelId: "UC_A" });
  assert.deepEqual([result.id, result.outcome], ["up_newest", "succeeded"]);
  assert.deepEqual(asked, [["UC_A", "V12"]]);
  assert.equal(await errorOf(waitOnce(reads, { target: "upload", id: "V12" })), notFoundShape("upload", "V12"));
});

test("AC-WT-03 media_session: until ready (default) and until ended, every status", async () => {
  const ready: Record<string, [boolean, string]> = {
    pending: [false, "still_running"],
    approved: [false, "still_running"],
    waiting_capacity: [false, "still_running"],
    starting: [false, "still_running"],
    running: [true, "succeeded"],
    stopping: [true, "failed"],
    done: [true, "failed"],
    failed: [true, "failed"],
    rejected: [true, "rejected"],
    interrupted: [true, "failed"],
  };
  const ended: Record<string, [boolean, string]> = { ...ready, running: [false, "still_running"], stopping: [false, "still_running"], done: [true, "succeeded"] };
  for (const [until, table] of [["ready", ready], ["ended", ended]] as const) {
    for (const [status, [final, outcome]] of Object.entries(table)) {
      const reads: WaitTargetReads = { mediaSession: async () => ({ sessionId: "s1", channelId: "UC_A", status }) };
      const result = await waitOnce(reads, { target: "media_session", id: "s1", ...(until === "ended" ? { until } : {}) });
      assert.deepEqual([result.final, result.outcome], [final, outcome], `${until} ${status}`);
    }
  }
});

test("AC-WT-03 media_job, gemini_job, speech_job, sound_job: every status", async () => {
  const media: Record<string, [boolean, string]> = {
    queued: [false, "still_running"],
    submitted: [false, "still_running"],
    generating: [false, "still_running"],
    transferring: [false, "still_running"],
    done: [true, "succeeded"],
    failed: [true, "failed"],
    cancelled: [true, "cancelled"],
  };
  for (const [status, [final, outcome]] of Object.entries(media)) {
    const result = await waitOnce({ mediaJob: async () => ({ jobId: "j1", channelId: "UC_A", status }) }, { target: "media_job", id: "j1" });
    assert.deepEqual([result.final, result.outcome], [final, outcome], `media ${status}`);
  }
  const provider: Record<string, [boolean, string]> = { queued: [false, "still_running"], submitting: [false, "still_running"], running: [false, "still_running"], done: [true, "succeeded"], failed: [true, "failed"] };
  for (const [status, [final, outcome]] of Object.entries(provider)) {
    for (const [target, reads] of [
      ["gemini_job", { geminiJob: async () => ({ job: { jobId: "gm_1", channelId: "UC_A", kind: "image", status } }) }],
      ["speech_job", { speechJob: async () => ({ provider: "elevenlabs", job: { jobId: "el_1", channelId: "UC_A", kind: "speech", status } }) }],
      ["sound_job", { soundJob: async () => ({ job: { jobId: "el_2", channelId: "UC_A", kind: "music", status } }) }],
    ] as const) {
      const result = await waitOnce(reads as WaitTargetReads, { target, id: "x" });
      assert.deepEqual([result.final, result.outcome], [final, outcome], `${target} ${status}`);
    }
  }
  // A sound wait on a speech take is not a sound job.
  assert.equal(
    await errorOf(waitOnce({ soundJob: async () => ({ job: { jobId: "el_3", channelId: "UC_A", kind: "speech", status: "done" } }) }, { target: "sound_job", id: "el_3" })),
    notFoundShape("sound_job", "el_3")
  );
});

test("AC-WT-03 translation_request: until finished (default) and until claimed; partly_done is partly_failed (Q3)", async () => {
  const finished: Record<string, [boolean, string]> = {
    requested: [false, "still_running"],
    in_progress: [false, "still_running"],
    done: [true, "succeeded"],
    partly_done: [true, "partly_failed"],
    failed: [true, "failed"],
    cancelled: [true, "cancelled"],
  };
  const claimed: Record<string, [boolean, string]> = { ...finished, in_progress: [true, "succeeded"], done: [true, "succeeded"], partly_done: [true, "succeeded"] };
  for (const [until, table] of [["finished", finished], ["claimed", claimed]] as const) {
    for (const [status, [final, outcome]] of Object.entries(table)) {
      const reads: WaitTargetReads = { translationRequests: async () => [{ requestId: "tr_1", status, videoIds: ["a", "b"] }] };
      const result = await waitOnce(reads, { target: "translation_request", id: "tr_1", channelId: "UC_A", ...(until === "claimed" ? { until } : {}) });
      assert.deepEqual([result.final, result.outcome], [final, outcome], `${until} ${status}`);
    }
  }
});

test("AC-WT-03 storyboard_review and storyboard_render: in_review runs, approved, changes_requested; a draft returns at once (not_in_review)", async () => {
  const review: Record<string, [boolean, string]> = { in_review: [false, "still_running"], approved: [true, "succeeded"], changes_requested: [true, "changes_requested"], draft: [false, "not_in_review"] };
  for (const [state, [final, outcome]] of Object.entries(review)) {
    const reads: WaitTargetReads = { storyboard: async () => ({ storyboard: { storyboardId: "sb_1", state, renders: [] } }) };
    const result = await waitOnce(reads, { target: "storyboard_review", id: "sb_1", channelId: "UC_A" });
    assert.deepEqual([result.final, result.outcome], [final, outcome], `review ${state}`);
  }
  for (const state of ["in_review", "approved", "changes_requested"]) {
    const reads: WaitTargetReads = { storyboard: async () => ({ storyboard: { storyboardId: "sb_1", state: "approved", renders: [{ renderId: "rd_1", state, decisions: [] }] } }) };
    const result = await waitOnce(reads, { target: "storyboard_render", id: "rd_1", channelId: "UC_A", storyboardId: "sb_1" });
    assert.deepEqual([result.final, result.outcome], [review[state][0], review[state][1]], `render ${state}`);
  }
  const noRender: WaitTargetReads = { storyboard: async () => ({ storyboard: { storyboardId: "sb_1", state: "approved", renders: [] } }) };
  assert.equal(await errorOf(waitOnce(noRender, { target: "storyboard_render", id: "rd_9", channelId: "UC_A", storyboardId: "sb_1" })), notFoundShape("storyboard_render", "rd_9"));
});

test("AC-WT-03 restart: open/restarting run; done (with toVersion/toSchema), expired, cancelled; current pins the id; no request -> no_restart_request", async () => {
  const table: Record<string, [boolean, string]> = { open: [false, "still_running"], restarting: [false, "still_running"], done: [true, "succeeded"], expired: [true, "expired"], cancelled: [true, "cancelled"] };
  for (const [status, [final, outcome]] of Object.entries(table)) {
    const request = { id: "rq_1", status, toVersion: status === "done" ? "0.1.2 (abc)" : null, toSchema: status === "done" ? 130 : null };
    const reads: WaitTargetReads = { restart: { byId: async () => request, active: async () => request, last: async () => null, serverStartedAt: () => "2026-11-17T10:00:00.000Z" } };
    const result = await waitOnce(reads, { target: "restart", id: "rq_1" });
    assert.deepEqual([result.final, result.outcome], [final, outcome], status);
    const current = await waitOnce(reads, { target: "restart", id: "current" });
    assert.equal(current.id, "rq_1", "current resolves to the request's id");
    if (status === "done") assert.deepEqual([result.snapshot.toVersion, result.snapshot.toSchema, result.snapshot.serverStartedAt], ["0.1.2 (abc)", 130, "2026-11-17T10:00:00.000Z"]);
  }
  const none: WaitTargetReads = { restart: { byId: async () => null, active: async () => null, last: async () => ({ id: "rq_0", status: "done" }), serverStartedAt: () => "2026-11-17T10:00:00.000Z" } };
  assert.equal(
    await errorOf(waitOnce(none, { target: "restart", id: "current" })),
    JSON.stringify({ code: "no_restart_request", message: "No restart request is open or restarting on this computer.", details: { serverStartedAt: "2026-11-17T10:00:00.000Z", lastRestart: { id: "rq_0", status: "done" } } })
  );
  assert.equal(await errorOf(waitOnce(none, { target: "restart", id: "rq_x" })), notFoundShape("restart", "rq_x"));
});

test("AC-WT-10 scoping: a worker on another channel's upload, session, job, Gemini/speech/sound job, request, storyboard or render gets the same not_found as a missing id", async () => {
  const otherChannel: WaitTargetReads = {
    upload: { byId: async () => uploadRow({ channelId: "UC_B" }), latest: async () => uploadRow({ channelId: "UC_B" }) },
    mediaSession: async () => ({ sessionId: "s1", channelId: "UC_B", status: "running" }),
    mediaJob: async () => ({ jobId: "j1", channelId: "UC_B", status: "done" }),
    geminiJob: async () => ({ job: { jobId: "gm_1", channelId: "UC_B", status: "done" } }),
    speechJob: async () => ({ provider: "gemini", job: { jobId: "gm_2", channelId: "UC_B", kind: "speech", status: "done" } }),
    soundJob: async () => ({ job: { jobId: "el_1", channelId: "UC_B", kind: "sfx", status: "done" } }),
  };
  const missing: WaitTargetReads = {
    upload: { byId: async () => null, latest: async () => null },
    mediaSession: async () => {
      throw new DomainError({ code: "media_session_not_found", message: "No session with this id", details: { sessionId: "s1" } });
    },
    mediaJob: async () => {
      throw new DomainError({ code: "media_job_not_found", message: "No job with this id" });
    },
    geminiJob: async () => {
      throw new DomainError({ code: "gemini_job_not_found", message: "No Gemini job" });
    },
    speechJob: async () => {
      throw new DomainError({ code: "gemini_job_not_found", message: "No speech job" });
    },
    soundJob: async () => {
      throw new DomainError({ code: "elevenlabs_job_not_found", message: "No job" });
    },
  };
  for (const [target, id] of [["upload", "up_1"], ["media_session", "s1"], ["media_job", "j1"], ["gemini_job", "gm_1"], ["speech_job", "gm_2"], ["sound_job", "el_1"]] as const) {
    const foreign = await errorOf(waitOnce(otherChannel, { target, id, channelId: "UC_A" }, WORKER_A));
    const absent = await errorOf(waitOnce(missing, { target, id, channelId: "UC_A" }, WORKER_A));
    assert.equal(foreign, notFoundShape(target, id), target);
    assert.equal(foreign, absent, `${target}: byte-identical to a missing id`);
    // The Operator (no scope) sees the same resource.
    if (target !== "upload") assert.equal((await waitOnce(otherChannel, { target, id }, OPERATOR)).final, true, `${target} for the Operator`);
  }
  // Requests and storyboards are read per channel: a worker's call names its own channel (pinned), so another channel's id is simply
  // absent there; a scope that does not match the input is refused the same way.
  const requests: WaitTargetReads = { translationRequests: async (channelId) => (channelId === "UC_B" ? [{ requestId: "tr_1", status: "done" }] : []) };
  assert.equal(await errorOf(waitOnce(requests, { target: "translation_request", id: "tr_1", channelId: "UC_B" }, WORKER_A)), notFoundShape("translation_request", "tr_1"));
  assert.equal(await errorOf(waitOnce(requests, { target: "translation_request", id: "tr_1", channelId: "UC_A" }, WORKER_A)), notFoundShape("translation_request", "tr_1"));
  const storyboards: WaitTargetReads = {
    storyboard: async (channelId) => {
      if (channelId !== "UC_B") throw new DomainError({ code: "storyboard_not_found", message: "No storyboard with this id in this channel" });
      return { storyboard: { state: "approved", renders: [{ renderId: "rd_1", state: "approved" }] } };
    },
  };
  for (const [target, extra] of [["storyboard_review", {}], ["storyboard_render", { storyboardId: "sb_1" }]] as const) {
    assert.equal(await errorOf(waitOnce(storyboards, { target, id: target === "storyboard_review" ? "sb_1" : "rd_1", channelId: "UC_A", ...extra }, WORKER_A)), notFoundShape(target, target === "storyboard_review" ? "sb_1" : "rd_1"));
  }
});

test("AC-WT-15: a target whose reads are missing answers target_unavailable; the others still work", async () => {
  const reads: WaitTargetReads = { mediaJob: async () => ({ jobId: "j1", channelId: "UC_A", status: "done" }) };
  assert.equal(JSON.parse(await errorOf(waitOnce(reads, { target: "gemini_job", id: "gm_1" }))).code, "target_unavailable");
  assert.equal((await waitOnce(reads, { target: "media_job", id: "j1" })).outcome, "succeeded");
  // A module whose read keeps failing (not a not-found) is target_unavailable after three reads, not not_found.
  let calls = 0;
  const broken: WaitTargetReads = {
    mediaJob: async () => {
      calls += 1;
      throw new Error("module could not load");
    },
  };
  let now = 0;
  const wait = createOperationWait({ ports: createWaitPorts(broken), now: () => now, sleep: async (ms) => void (now += ms), shutdownSignal: () => new AbortController().signal, restarting: async () => false });
  await assert.rejects(wait.waitFor({ target: "media_job", id: "j1", timeoutSeconds: 240 }, OPERATOR), (error: unknown) => isDomainError(error) && error.code === "target_unavailable");
  assert.equal(calls, 3);
});
