import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { mediaJobsReportSchema, type MediaJobsReport, type SharedJobCommand, type SharedMediaJob } from "@/lib/sync-gateway";
import {
  applyIncomingCommands,
  commandViews,
  prepareCommand,
  toCommandResults,
  toReportCommands,
  type CommandExecutors,
  type CommandStore,
  type StoredOutgoingCommand,
  type StoredReceivedCommand,
} from "./commands";

// BL-188 stage 2 -- SHARED_MEDIA_JOBS_PLAN.md §2.3/§2.4 and acceptance §4.1 items 4-6. Expected values come from the plan:
// a command is applied once (the same commandId twice, or in two reports, is one action), a cancel of a finished job is
// `already_finished`, a create refused by the executor's own checks carries that code and creates nothing, a create first seen
// more than 15 minutes after it was issued is `command_expired`, commands apply in `issuedAt` order, and a command for another
// computer or from this computer itself is ignored.

const A = "device-A"; // the executor (runs the jobs)
const B = "device-B"; // the clicking computer
const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function memoryStore() {
  const out: StoredOutgoingCommand[] = [];
  const received = new Map<string, StoredReceivedCommand>();
  const store: CommandStore = {
    async insertOutgoing(row) {
      out.push(row);
    },
    async listOutgoing(sinceIso, limit) {
      return out.filter((r) => r.issuedAt >= sinceIso).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)).slice(0, limit);
    },
    async claim(row) {
      if (received.has(row.commandId)) return false;
      received.set(row.commandId, { ...row, status: "applying", code: null, jobId: null, finishedAt: null });
      return true;
    },
    async finish(commandId, set) {
      const row = received.get(commandId);
      if (row && row.status === "applying") received.set(commandId, { ...row, ...set });
    },
    async known(ids) {
      return new Set(ids.filter((id) => received.has(id)));
    },
    async listReceived(sinceIso, limit) {
      return [...received.values()].filter((r) => r.receivedAt >= sinceIso).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, limit);
    },
  };
  return { store, out, received };
}

type Call = { action: string; args: unknown };

function fakeExecutors(overrides: Partial<CommandExecutors> = {}) {
  const calls: Call[] = [];
  const executors: CommandExecutors = {
    async cancelJob(args) {
      calls.push({ action: "cancelJob", args });
      return "cancelled";
    },
    async createJob(args) {
      calls.push({ action: "createJob", args });
      return { jobId: "mj_new" };
    },
    async approveSession(args) {
      calls.push({ action: "approveSession", args });
    },
    async rejectSession(args) {
      calls.push({ action: "rejectSession", args });
    },
    async createGeminiJob(args) {
      calls.push({ action: "createGeminiJob", args });
      return { jobId: "gm_new" };
    },
    ...overrides,
  };
  return { executors, calls };
}

function command(overrides: Partial<SharedJobCommand> & Pick<SharedJobCommand, "commandId" | "kind">): SharedJobCommand {
  return {
    targetDeviceId: A,
    source: null,
    jobId: null,
    sessionId: null,
    channelId: null,
    create: null,
    reason: null,
    issuedAt: iso(T0),
    issuedOn: "Windows PC",
    ...overrides,
  };
}

const cancel = (commandId: string, extra: Partial<SharedJobCommand> = {}) => command({ commandId, kind: "cancel_job", source: "runpod", jobId: "mj_1", channelId: "UC1", ...extra });
const create = (commandId: string, extra: Partial<SharedJobCommand> = {}) =>
  command({ commandId, kind: "create_job", sessionId: "ms_1", channelId: "UC1", create: { templateId: "tpl_music", params: { prompt: "rain" } }, ...extra });

function report(deviceId: string, commands: SharedJobCommand[], extra: Partial<MediaJobsReport> = {}): MediaJobsReport {
  return mediaJobsReportSchema.parse({ format: "ytm-media-jobs", version: 2, deviceId, hostName: deviceId === A ? "Mac" : "Windows PC", updatedAt: iso(T0), jobs: [], commands, commandResults: [], ...extra });
}

const clockAt = (ms: number) => () => new Date(ms);

test("§4.1 item 4: a cancel from B is applied once on A, through the executor's own cancel", async () => {
  const { store, received } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const peers = [report(B, [cancel("cmd-cancel-1")])];
  const first = await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 60_000) });
  assert.deepEqual(first, [{ commandId: "cmd-cancel-1", kind: "cancel_job", status: "applied", code: null }]);
  assert.deepEqual(calls, [{ action: "cancelJob", args: { source: "runpod", jobId: "mj_1", channelId: "UC1" } }]);
  // The same report seen again (the next tick, a replay): nothing more happens.
  const again = await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 120_000) });
  assert.deepEqual(again, []);
  assert.equal(calls.length, 1);
  assert.equal(received.get("cmd-cancel-1")!.status, "applied");
  assert.equal(received.get("cmd-cancel-1")!.issuerDeviceId, B);
});

test("§4.1 item 4: the same commandId in two computers' reports is still one action", async () => {
  const { store } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const peers = [report(B, [cancel("cmd-dup-1")]), report("device-C", [cancel("cmd-dup-1")])];
  await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 1000) });
  assert.equal(calls.length, 1);
});

test("§4.1 item 4: a cancel of a job that had finished is recorded as already_finished, not as an error", async () => {
  const { store, received } = memoryStore();
  const { executors } = fakeExecutors({ cancelJob: async () => "already_finished" });
  const out = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [cancel("cmd-late-cancel")])], store, executors, now: clockAt(T0 + 1000) });
  assert.deepEqual(out[0], { commandId: "cmd-late-cancel", kind: "cancel_job", status: "applied", code: "already_finished" });
  assert.equal(received.get("cmd-late-cancel")!.code, "already_finished");
});

test("§4.1 item 5: a create the executor's own checks refuse (over a limit, closed session, gate) carries that code and makes no job", async () => {
  for (const [i, code] of ["media_limit_exceeded", "media_session_invalid_state", "storyboard_not_approved", "CHANNEL_NOT_AUTHORIZED"].entries()) {
    const id = `cmd-refused-${i}`;
    const { store, received } = memoryStore();
    const { executors, calls } = fakeExecutors({
      createJob: async (args) => {
        calls.push({ action: "createJob", args });
        throw new DomainError({ code: code as never, message: "refused by the executor", details: {} });
      },
    });
    const out = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [create(id)])], store, executors, now: clockAt(T0 + 1000) });
    assert.deepEqual(out[0], { commandId: id, kind: "create_job", status: "refused", code });
    assert.equal(received.get(id)!.jobId, null);
    assert.equal(calls.length, 1, "the executor's own create was asked exactly once");
  }
});

test("§4.1 item 5 / §2.3 expiry: a create first seen more than 15 minutes after it was issued is command_expired; at 15 minutes exactly it runs", async () => {
  const late = memoryStore();
  const lateExec = fakeExecutors();
  const out = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [create("cmd-create-late")])], store: late.store, executors: lateExec.executors, now: clockAt(T0 + 15 * 60_000 + 1) });
  assert.deepEqual(out[0], { commandId: "cmd-create-late", kind: "create_job", status: "refused", code: "command_expired" });
  assert.deepEqual(lateExec.calls, [], "nothing created, nothing spent");

  const onTime = memoryStore();
  const onTimeExec = fakeExecutors();
  const ok = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [create("cmd-create-edge")])], store: onTime.store, executors: onTimeExec.executors, now: clockAt(T0 + 15 * 60_000) });
  assert.equal(ok[0].status, "applied");
  assert.equal(onTime.received.get("cmd-create-edge")!.jobId, "mj_new");
  assert.deepEqual(onTimeExec.calls, [{ action: "createJob", args: { sessionId: "ms_1", channelId: "UC1", templateId: "tpl_music", params: { prompt: "rain" } } }]);
});

test("§2.3: a cancel does not expire with the 15-minute rule (the executor was off for two hours)", async () => {
  const { store } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const out = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [cancel("cmd-cancel-old")])], store, executors, now: clockAt(T0 + 2 * 60 * 60_000) });
  assert.equal(out[0].status, "applied");
  assert.equal(calls.length, 1);
});

test("§4.1 item 6: commands apply in issuedAt order; one for another computer, or from this computer itself, is ignored", async () => {
  const { store } = memoryStore();
  const order: string[] = [];
  const { executors } = fakeExecutors({
    cancelJob: async ({ jobId }) => {
      order.push(jobId);
      return "cancelled";
    },
  });
  const peers = [
    report(B, [cancel("cmd-third", { jobId: "mj_3", issuedAt: iso(T0 + 3000) }), cancel("cmd-first", { jobId: "mj_1", issuedAt: iso(T0 + 1000) }), cancel("cmd-elsewhere", { jobId: "mj_x", targetDeviceId: "device-C" })]),
    report("device-C", [cancel("cmd-second", { jobId: "mj_2", issuedAt: iso(T0 + 2000) })]),
    // A report carrying this computer's own id (a copied folder): never applied.
    report(A, [cancel("cmd-self", { jobId: "mj_self" })]),
  ];
  await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 10_000) });
  assert.deepEqual(order, ["mj_1", "mj_2", "mj_3"]);
});

test("restart safety: a command taken but never finished is not applied again, and is reported as interrupted after 30 minutes", async () => {
  const { store, received } = memoryStore();
  await store.claim({ commandId: "cmd-crashed", issuerDeviceId: B, issuedOn: null, kind: "create_job", targetJson: "{}", issuedAt: iso(T0), receivedAt: iso(T0) });
  const { executors, calls } = fakeExecutors();
  await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [create("cmd-crashed")])], store, executors, now: clockAt(T0 + 60_000) });
  assert.deepEqual(calls, [], "never re-applied (it might already have spent)");
  const rows = [...received.values()];
  assert.equal(toCommandResults(rows, new Date(T0 + 29 * 60_000))[0].status, "applying");
  const later = toCommandResults(rows, new Date(T0 + 30 * 60_000 + 1))[0];
  assert.equal(later.status, "refused");
  assert.equal(later.code, "command_interrupted");
});

test("§2.1 privacy: a refusal crosses as a code only -- an unexpected error's text never reaches the report", async () => {
  const { store, received } = memoryStore();
  const { executors } = fakeExecutors({
    cancelJob: async () => {
      throw new Error("ComfyUI at https://abc-8188.proxy.runpod.net?token=SECRET said no");
    },
  });
  await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [cancel("cmd-boom")])], store, executors, now: clockAt(T0 + 1000) });
  const results = toCommandResults([...received.values()], new Date(T0 + 2000));
  assert.deepEqual(results, [{ commandId: "cmd-boom", issuerDeviceId: B, kind: "cancel_job", status: "refused", code: "command_failed", jobId: null, at: results[0].at }]);
  assert.ok(!JSON.stringify(results).includes("SECRET"));
  // The report accepts the results as they are.
  mediaJobsReportSchema.parse({ format: "ytm-media-jobs", version: 2, deviceId: A, hostName: "Mac", updatedAt: iso(T0), jobs: [], commands: [], commandResults: results });
});

test("approve and reject a session request: each reaches the executor's own approve / reject once", async () => {
  const { store } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const peers = [
    report(B, [
      command({ commandId: "cmd-approve", kind: "approve_session", sessionId: "ms_pending", channelId: "UC1" }),
      command({ commandId: "cmd-reject", kind: "reject_session", sessionId: "ms_other", channelId: "UC1", reason: null, issuedAt: iso(T0 + 1) }),
    ]),
  ];
  await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 1000) });
  assert.deepEqual(calls, [
    { action: "approveSession", args: { sessionId: "ms_pending" } },
    { action: "rejectSession", args: { sessionId: "ms_other", reason: "Rejected from another computer." } },
  ]);
});

test("the report schema (versions 1-3): commands and results are strict; a version 1 report is still read", () => {
  const base = { format: "ytm-media-jobs", deviceId: B, hostName: "Windows PC", updatedAt: iso(T0), jobs: [] };
  assert.ok(mediaJobsReportSchema.safeParse({ ...base, version: 1 }).success);
  assert.ok(mediaJobsReportSchema.safeParse({ ...base, version: 2, commands: [cancel("cmd-ok-12")], commandResults: [] }).success);
  // An extra field (e.g. a URL) is refused.
  assert.ok(!mediaJobsReportSchema.safeParse({ ...base, version: 2, commands: [{ ...cancel("cmd-extra-1"), url: "https://x" }] }).success);
  // A kind without its target is refused.
  assert.ok(!mediaJobsReportSchema.safeParse({ ...base, version: 2, commands: [cancel("cmd-nojob-1", { jobId: null })] }).success);
  assert.ok(!mediaJobsReportSchema.safeParse({ ...base, version: 2, commands: [create("cmd-nocreate", { create: null })] }).success);
  // A result's code is a code, not a sentence.
  assert.ok(
    !mediaJobsReportSchema.safeParse({ ...base, version: 2, commandResults: [{ commandId: "cmd-res-01", issuerDeviceId: A, kind: "cancel_job", status: "refused", code: "it failed at https://x", jobId: null, at: iso(T0) }] }).success
  );
  // Stage 4 (owner msg 2806 Q3) made version 3 this build's (Gemini creates); a version 4 report is not.
  assert.ok(mediaJobsReportSchema.safeParse({ ...base, version: 3 }).success);
  assert.ok(!mediaJobsReportSchema.safeParse({ ...base, version: 4 }).success);
});

test("toReportCommands: a stored command that no longer fits the schema is left out, the others go", () => {
  const rows: StoredOutgoingCommand[] = [
    { commandId: "cmd-good-01", targetDeviceId: A, kind: "cancel_job", commandJson: JSON.stringify(cancel("cmd-good-01")), issuedAt: iso(T0) },
    { commandId: "cmd-bad-01", targetDeviceId: A, kind: "cancel_job", commandJson: "{not json", issuedAt: iso(T0) },
    { commandId: "cmd-bad-02", targetDeviceId: A, kind: "cancel_job", commandJson: JSON.stringify({ ...cancel("cmd-bad-02"), jobId: null }), issuedAt: iso(T0) },
  ];
  assert.deepEqual(
    toReportCommands(rows).map((c) => c.commandId),
    ["cmd-good-01"]
  );
});

// ------------------------------------------------------------------------------------------- the clicking computer's view

test("§2.3 status line: waiting, then the target's answer; a stale target is offline; a create unanswered after 15 min is expired", () => {
  const now = new Date(T0 + 20 * 60_000);
  const outgoing = [cancel("cmd-v-wait"), cancel("cmd-v-done", { jobId: "mj_2" }), create("cmd-v-create"), cancel("cmd-v-refused", { jobId: "mj_3" })];
  const target = report(A, [], {
    updatedAt: iso(T0 + 19 * 60_000),
    commandResults: [
      { commandId: "cmd-v-done", issuerDeviceId: B, kind: "cancel_job", status: "applied", code: null, jobId: "mj_2", at: iso(T0 + 60_000) },
      { commandId: "cmd-v-refused", issuerDeviceId: B, kind: "cancel_job", status: "refused", code: "media_job_not_found", jobId: null, at: iso(T0 + 60_000) },
      // Another computer's command with the same id is not this one's answer.
      { commandId: "cmd-v-wait", issuerDeviceId: "device-C", kind: "cancel_job", status: "applied", code: null, jobId: null, at: iso(T0 + 60_000) },
    ],
  });
  const views = commandViews({ ownDeviceId: B, outgoing, peers: [target], now });
  const byId = new Map(views.map((v) => [v.commandId, v]));
  assert.equal(byId.get("cmd-v-wait")!.state, "waiting");
  assert.equal(byId.get("cmd-v-done")!.state, "applied");
  assert.equal(byId.get("cmd-v-refused")!.state, "refused");
  assert.equal(byId.get("cmd-v-refused")!.code, "media_job_not_found");
  assert.equal(byId.get("cmd-v-create")!.state, "expired");
  assert.equal(byId.get("cmd-v-wait")!.targetOffline, false);
  assert.equal(byId.get("cmd-v-wait")!.targetHostName, "Mac");

  const stale = commandViews({ ownDeviceId: B, outgoing: [cancel("cmd-v-off")], peers: [report(A, [], { updatedAt: iso(T0) })], now: new Date(T0 + 5 * 60_000 + 1) });
  assert.equal(stale[0].targetOffline, true);
  const missing = commandViews({ ownDeviceId: B, outgoing: [cancel("cmd-v-none")], peers: [], now });
  assert.equal(missing[0].targetOffline, true);
  assert.equal(missing[0].state, "waiting");
});

// ------------------------------------------------------------------------------------------- issuing (the route's checks)

function job(overrides: Partial<SharedMediaJob>): SharedMediaJob {
  return {
    jobId: "mj_1",
    source: "runpod",
    channelId: "UC1",
    mediaKind: "audio",
    status: "generating",
    createdBy: "operator",
    label: "Music v1",
    sessionId: "ms_1",
    progress: null,
    plan: null,
    storyboard: null,
    costUsd: null,
    costIsEstimate: false,
    errorCode: null,
    createdAt: iso(T0),
    submittedAt: iso(T0),
    finishedAt: null,
    outputs: [],
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error), String(error));
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

function issue(raw: unknown, overrides: { activeChannelId?: string | null; connected?: boolean; jobs?: SharedMediaJob[]; sessions?: Array<{ sessionId: string; channelId: string; status: string }> } = {}) {
  return prepareCommand({
    raw,
    ownDeviceId: B,
    ownHostName: "Windows PC",
    activeChannelId: overrides.activeChannelId === undefined ? "UC1" : overrides.activeChannelId,
    jobReports: [report(A, [], { jobs: overrides.jobs ?? [job({}), job({ jobId: "gm_1", source: "gemini", status: "queued", sessionId: null }), job({ jobId: "gm_2", source: "gemini", status: "running", sessionId: null }), job({ jobId: "mj_done", status: "done" }), job({ jobId: "mj_other", channelId: "UC2" })] })],
    peerSessions: (overrides.sessions ?? [
      { sessionId: "ms_1", channelId: "UC1", status: "running" },
      { sessionId: "ms_pending", channelId: "UC1", status: "pending" },
      { sessionId: "ms_stopped", channelId: "UC1", status: "stopped" },
      { sessionId: "ms_uc2", channelId: "UC2", status: "running" },
    ]).map((s) => ({ deviceId: A, ...s })),
    isConnectedChannel: async () => overrides.connected ?? true,
    now: new Date(T0),
    newId: () => "11111111-2222-3333-4444-555555555555",
  });
}

test("issuing: a cancel of A's running job of the active channel becomes a command addressed to A", async () => {
  const c = await issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_1" });
  assert.deepEqual(c, {
    commandId: "11111111-2222-3333-4444-555555555555",
    kind: "cancel_job",
    targetDeviceId: A,
    source: "runpod",
    jobId: "mj_1",
    sessionId: null,
    channelId: "UC1",
    create: null,
    reason: null,
    issuedAt: iso(T0),
    issuedOn: "Windows PC",
  });
  assert.equal((await issue({ kind: "cancel_job", targetDeviceId: A, source: "gemini", jobId: "gm_1" })).source, "gemini");
});

test("issuing refuses what can never apply: own computer, unknown or other-channel job, finished job, Gemini already sent", async () => {
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: B, source: "runpod", jobId: "mj_1" }), "validation_failed");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_missing" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: "device-C", source: "runpod", jobId: "mj_1" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_other" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_1" }, { activeChannelId: null }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_done" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "gemini", jobId: "gm_2" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "gemini", jobId: "mj_1" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, jobId: "mj_1" }), "validation_failed");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_1", url: "x" }), "validation_failed");
});

test("issuing a run: only on A's RUNNING session of the active channel", async () => {
  const c = await issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_1", templateId: "tpl_music", params: { prompt: "rain", seed: 7 } });
  assert.deepEqual(c.create, { templateId: "tpl_music", params: { prompt: "rain", seed: 7 } });
  assert.equal(c.channelId, "UC1");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_stopped", templateId: "tpl_music" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_uc2", templateId: "tpl_music" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_unknown", templateId: "tpl_music" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_1" }), "validation_failed");
});

test("issuing approve / reject: only a PENDING request whose channel is connected here", async () => {
  assert.equal((await issue({ kind: "approve_session", targetDeviceId: A, sessionId: "ms_pending" })).kind, "approve_session");
  const reject = await issue({ kind: "reject_session", targetDeviceId: A, sessionId: "ms_pending", reason: "  too expensive  " });
  assert.equal(reject.reason, "too expensive");
  await expectCode(issue({ kind: "approve_session", targetDeviceId: A, sessionId: "ms_1" }), "media_job_command_invalid");
  await expectCode(issue({ kind: "approve_session", targetDeviceId: A, sessionId: "ms_pending" }, { connected: false }), "channel_not_connected");
});

// ---------------------------------------------------------------------------
// BL-188 stage 4 (SHARED_MEDIA_JOBS_PLAN.md §5 item 4, §2.3/§2.4; owner msg 2806 Q3): a Gemini job launched on another computer.
// Expected from the plan: the request crosses as a create_job with source "gemini" (no session, no template), the executor runs
// its OWN Gemini create (its switch, key, limits; a refusal carries its code and makes nothing), the request id is derived from
// the command so a replay cannot pay twice, a run first seen after 15 minutes is command_expired, and only the shape is checked
// on the issuing computer (the channel is the active one, the target must report).
// ---------------------------------------------------------------------------

const geminiRequest = { kind: "image" as const, model: "gemini-nano-banana-2.1", prompt: "a quiet tea house", image: { size: "1K", aspectRatio: "16:9" } };
const geminiCreate = (commandId: string, extra: Partial<SharedJobCommand> = {}) =>
  command({ commandId, kind: "create_job", source: "gemini", channelId: "UC1", gemini: geminiRequest, ...extra });

test("stage 4: a Gemini run from B is applied once on A through A's own Gemini create, with a request id from the command", async () => {
  const { store, received } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const peers = [report(B, [geminiCreate("cmd-gemini-01")], { version: 3 })];
  const out = await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 60_000) });
  assert.deepEqual(out, [{ commandId: "cmd-gemini-01", kind: "create_job", status: "applied", code: null }]);
  assert.deepEqual(calls, [{ action: "createGeminiJob", args: { commandId: "cmd-gemini-01", channelId: "UC1", request: geminiRequest } }]);
  assert.equal(received.get("cmd-gemini-01")!.jobId, "gm_new");
  // The ledger keeps what was asked, never the prompt.
  assert.equal(received.get("cmd-gemini-01")!.targetJson.includes("tea house"), false);
  assert.deepEqual(await applyIncomingCommands({ ownDeviceId: A, peers, store, executors, now: clockAt(T0 + 120_000) }), []);
  assert.equal(calls.length, 1, "a replay never creates (or pays for) a second job");
});

test("stage 4: A's own Gemini checks refuse with their code (limit, switch off, no key, bad settings) and nothing is made", async () => {
  for (const [i, code] of ["gemini_limit_exceeded", "gemini_disabled", "gemini_key_missing", "gemini_invalid_params", "storyboard_not_approved"].entries()) {
    const { store, received } = memoryStore();
    const { executors } = fakeExecutors({
      createGeminiJob: async () => {
        throw new DomainError({ code: code as never, message: `refused: ${code}` });
      },
    });
    const id = `cmd-gemini-ref-${i}`;
    const out = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [geminiCreate(id)], { version: 3 })], store, executors, now: clockAt(T0 + 1000) });
    assert.deepEqual(out, [{ commandId: id, kind: "create_job", status: "refused", code }]);
    assert.equal(received.get(id)!.jobId, null);
  }
});

test("stage 4: a Gemini run first seen more than 15 minutes after it was issued is command_expired and never reaches Gemini", async () => {
  const { store } = memoryStore();
  const { executors, calls } = fakeExecutors();
  const late = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [geminiCreate("cmd-gemini-late")], { version: 3 })], store, executors, now: clockAt(T0 + 15 * 60_000 + 1) });
  assert.deepEqual(late, [{ commandId: "cmd-gemini-late", kind: "create_job", status: "refused", code: "command_expired" }]);
  assert.equal(calls.length, 0);
  const onTime = await applyIncomingCommands({ ownDeviceId: A, peers: [report(B, [geminiCreate("cmd-gemini-15m")], { version: 3 })], store, executors, now: clockAt(T0 + 15 * 60_000) });
  assert.equal(onTime[0].status, "applied");
});

test("stage 4: the schema -- a Gemini run needs the request and no session or template; a RunPod run carries no Gemini request", () => {
  const base = { format: "ytm-media-jobs", version: 3, deviceId: B, hostName: "Windows PC", updatedAt: iso(T0), jobs: [], commandResults: [] };
  const ok = (commands: unknown[]) => mediaJobsReportSchema.safeParse({ ...base, commands }).success;
  assert.ok(ok([geminiCreate("cmd-g-ok-01")]));
  assert.ok(!ok([geminiCreate("cmd-g-nogem", { gemini: undefined })]));
  assert.ok(!ok([geminiCreate("cmd-g-sess1", { sessionId: "ms_1" })]));
  assert.ok(!ok([geminiCreate("cmd-g-tmpl1", { create: { templateId: "t", params: {} } })]));
  assert.ok(!ok([geminiCreate("cmd-g-noch1", { channelId: null })]));
  assert.ok(!ok([create("cmd-rp-gem01", { gemini: geminiRequest })]));
  assert.ok(!ok([cancel("cmd-cn-gem01", { gemini: geminiRequest })]));
  // The request's own shape: an image request takes `image`, paths are relative, no extra field (a key, a URL).
  assert.ok(!ok([geminiCreate("cmd-g-mix01", { gemini: { ...geminiRequest, video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } } })]));
  assert.ok(!ok([geminiCreate("cmd-g-abs01", { gemini: { ...geminiRequest, image: { size: "1K", aspectRatio: "1:1", inputs: { images: ["/Users/owner/x.png"] } } } })]));
  assert.ok(!ok([geminiCreate("cmd-g-dot01", { gemini: { ...geminiRequest, image: { size: "1K", aspectRatio: "1:1", inputs: { images: ["a/../../x.png"] } } } })]));
  assert.ok(!ok([geminiCreate("cmd-g-key01", { gemini: { ...geminiRequest, apiKey: "AIza..." } as never })]));
  assert.ok(!ok([geminiCreate("cmd-g-long1", { gemini: { ...geminiRequest, prompt: "x".repeat(10_001) } })]));
  assert.ok(ok([geminiCreate("cmd-g-max01", { gemini: { ...geminiRequest, prompt: "x".repeat(10_000) } })]));
});

test("stage 4 issuing: a Gemini run becomes a create_job for the active channel addressed to a computer that reports", async () => {
  const c = await issue({ kind: "create_job", targetDeviceId: A, source: "gemini", gemini: geminiRequest });
  assert.deepEqual(c, {
    commandId: "11111111-2222-3333-4444-555555555555",
    kind: "create_job",
    targetDeviceId: A,
    source: "gemini",
    jobId: null,
    sessionId: null,
    channelId: "UC1",
    create: null,
    reason: null,
    gemini: geminiRequest,
    issuedAt: iso(T0),
    issuedOn: "Windows PC",
  });
  assert.deepEqual(commandViews({ ownDeviceId: B, outgoing: [c], peers: [], now: new Date(T0) })[0].label, "gemini-nano-banana-2.1");
});

test("stage 4 issuing refuses: no active channel, an unknown computer, this computer, a bad request, a session or template beside it", async () => {
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, source: "gemini", gemini: geminiRequest }, { activeChannelId: null }), "media_job_command_invalid");
  await expectCode(issue({ kind: "create_job", targetDeviceId: "device-C", source: "gemini", gemini: geminiRequest }), "media_job_command_invalid");
  await expectCode(issue({ kind: "create_job", targetDeviceId: B, source: "gemini", gemini: geminiRequest }), "validation_failed");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, source: "gemini" }), "validation_failed");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, source: "gemini", gemini: { ...geminiRequest, prompt: "" } }), "validation_failed");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, source: "gemini", gemini: geminiRequest, sessionId: "ms_1" }), "validation_failed");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, source: "gemini", gemini: geminiRequest, templateId: "tpl_music" }), "validation_failed");
  await expectCode(issue({ kind: "cancel_job", targetDeviceId: A, source: "runpod", jobId: "mj_1", gemini: geminiRequest }), "validation_failed");
  await expectCode(issue({ kind: "create_job", targetDeviceId: A, sessionId: "ms_1", templateId: "tpl_music", gemini: geminiRequest }), "validation_failed");
});
