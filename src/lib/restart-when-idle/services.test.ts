import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { RestartBusyReaders, RestartHoldRow, RestartRequestRow, RestartStore } from "./contracts";
import { createRestartWhenIdle } from "./services";

// BL-220 (docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md): one test per acceptance criterion AC-RI-01..09, with the expected values
// taken from the plan (quiet minutes 1-30, default 3; holds 1-60 minutes with a reason; 24 h expiry; stop exactly once; only the
// system service restarts itself) -- never from running the implementation. A fake clock, fake readers, an in-memory store and a
// `stop` that counts its calls.

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const MIN = 60_000;

function fixture(options: { serviceMode?: boolean } = {}) {
  const state = {
    now: T0,
    serviceMode: options.serviceMode ?? true,
    stops: 0,
    file: null as string | null,
    logs: [] as Array<{ event: string; context: Record<string, unknown> }>,
    build: { version: "0.9.0 (abc123def456)", schema: 108 },
    requests: [] as RestartRequestRow[],
    holds: [] as RestartHoldRow[],
    quiet: null as number | null,
    nextId: 0,
  };
  const busy: Record<"mediaSessions" | "mediaJobs" | "geminiJobs" | "uploads" | "liveStreams" | "operations" | "batches", string[]> & {
    operationLock: string | null;
    lastMcpCallAt: number | null;
    failing: Set<string>;
  } = { mediaSessions: [], mediaJobs: [], geminiJobs: [], uploads: [], liveStreams: [], operations: [], batches: [], operationLock: null, lastMcpCallAt: null, failing: new Set() };
  const guard = async <T>(name: string, value: T): Promise<T> => {
    if (busy.failing.has(name)) throw new Error(`${name} unavailable`);
    return value;
  };
  const readers: RestartBusyReaders = {
    mediaSessions: () => guard("mediaSessions", busy.mediaSessions),
    mediaJobs: () => guard("mediaJobs", busy.mediaJobs),
    geminiJobs: () => guard("geminiJobs", busy.geminiJobs),
    uploads: () => guard("uploads", busy.uploads),
    liveStreams: () => guard("liveStreams", busy.liveStreams),
    operations: () => guard("operations", busy.operations),
    batches: () => guard("batches", busy.batches),
    operationLock: () => guard("operationLock", busy.operationLock),
    lastMcpCallAt: () => guard("lastMcpCallAt", busy.lastMcpCallAt),
  };
  const store: RestartStore = {
    listRequests: async (statuses) => state.requests.filter((row) => statuses.includes(row.status)).map((row) => ({ ...row })),
    insertRequest: async (row) => void state.requests.push({ ...row }),
    updateRequest: async (id, expected, set) => {
      const row = state.requests.find((r) => r.id === id);
      if (!row || row.status !== expected) return false;
      Object.assign(row, set);
      return true;
    },
    lastDone: async () => [...state.requests].filter((r) => r.status === "done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] ?? null,
    insertHold: async (row) => void state.holds.push({ ...row }),
    getHold: async (id) => state.holds.find((h) => h.id === id) ?? null,
    listActiveHolds: async (now) => state.holds.filter((h) => h.releasedAt === null && h.until > now),
    releaseHold: async (id, by, at) => {
      const hold = state.holds.find((h) => h.id === id);
      if (!hold || hold.releasedAt !== null) return false;
      hold.releasedAt = at;
      hold.releasedBy = by;
      return true;
    },
    getQuietMinutes: async () => state.quiet,
    setQuietMinutes: async (minutes) => void (state.quiet = minutes),
  };
  const service = createRestartWhenIdle({
    store,
    readers,
    clock: () => state.now,
    newId: () => `id-${++state.nextId}`,
    serviceMode: () => state.serviceMode,
    build: () => state.build,
    stop: () => void state.stops++,
    takeRequestFile: async () => {
      const text = state.file;
      state.file = null;
      return text;
    },
    log: (event, context) => void state.logs.push({ event, context }),
  });
  return { service, state, busy };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("AC-RI-01: each of the eight reasons alone keeps the request waiting, and waitingFor names it", async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void | Promise<void>]> = [
    ["media_session", (f) => void (f.busy.mediaSessions = ["S1"])],
    ["media_job", (f) => void (f.busy.mediaJobs = ["J1"])],
    ["gemini_job", (f) => void (f.busy.geminiJobs = ["G1"])],
    ["upload", (f) => void (f.busy.uploads = ["U1"])],
    ["live_stream", (f) => void (f.busy.liveStreams = ["UC1:switching"])],
    ["operation_lock", (f) => void (f.busy.operationLock = "import")],
    ["hold", async (f) => void (await f.service.hold({ heldBy: "factory", minutes: 10, reason: "rendering V12" }))],
    // An MCP call one minute ago, with the default 3 quiet minutes.
    ["mcp_quiet", (f) => void (f.busy.lastMcpCallAt = T0 - MIN)],
  ];
  for (const [kind, arrange] of cases) {
    const f = fixture();
    await arrange(f);
    await f.service.request("owner");
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.state.stops, 0, `${kind}: no stop`);
    assert.equal(f.state.requests[0].status, "open", `${kind}: still open`);
    const status = await f.service.status();
    assert.deepEqual(status.waitingFor.map((reason) => reason.kind), [kind], kind);
    assert.equal(status.waitingFor[0].count, 1, kind);
  }
});

test("AC-RI-01: the MCP quiet window and a hold report until when; a reader that fails keeps the request waiting (check_failed)", async () => {
  const f = fixture();
  f.busy.lastMcpCallAt = T0 - MIN;
  const { hold } = await f.service.hold({ heldBy: "owner", minutes: 5, reason: "checking the logs" });
  const status = await f.service.status();
  assert.deepEqual(
    status.waitingFor.map((reason) => [reason.kind, reason.until]),
    [
      ["hold", "2026-10-24T10:05:00.000Z"],
      ["mcp_quiet", "2026-10-24T10:02:00.000Z"],
    ]
  );
  assert.deepEqual(status.waitingFor[0].ids, [hold.holdId]);

  const failing = fixture();
  failing.busy.failing.add("uploads");
  await failing.service.request("owner");
  await failing.service.tick();
  assert.equal(failing.state.stops, 0);
  assert.deepEqual((await failing.service.status()).waitingFor, [{ kind: "check_failed", count: 1, ids: ["uploads"], until: null }]);
});

test("AC-RI-02: with nothing waiting the next check records restarting and sends the stop signal exactly once", async () => {
  const f = fixture();
  await f.service.request("owner");
  f.state.now = T0 + 7 * MIN;
  await f.service.tick();
  await f.service.tick();
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.state.stops, 1);
  const row = f.state.requests[0];
  assert.equal(row.status, "restarting");
  assert.equal(row.restartingAt, T0 + 7 * MIN);
  assert.equal(row.fromVersion, "0.9.0 (abc123def456)");
  assert.equal(row.fromSchema, 108);
  assert.equal(row.waitedMinutes, 7);
});

test("AC-RI-02: a 24/7 stream that is simply running is not a reason (only starting / stopping / switching ones are listed)", async () => {
  // The live-streams reader lists transitions only; a running stream gives an empty list.
  const f = fixture();
  f.busy.liveStreams = [];
  await f.service.request("developer");
  await f.service.tick();
  assert.equal(f.state.stops, 1);
});

test("AC-RI-02: a reason that clears lets the next check restart", async () => {
  const f = fixture();
  f.busy.uploads = ["U1"];
  await f.service.request("owner");
  await f.service.tick();
  assert.equal(f.state.stops, 0);
  f.busy.uploads = [];
  f.state.now += 15_000;
  await f.service.tick();
  assert.equal(f.state.stops, 1);
});

test("AC-RI-03: a hold of N minutes waits until `until` (an expired hold is ignored); its release ends it earlier", async () => {
  const f = fixture();
  await f.service.hold({ heldBy: "factory", minutes: 1, reason: "short job" });
  await f.service.request("owner");
  f.state.now = T0 + 59_000;
  await f.service.tick();
  assert.equal(f.state.stops, 0, "59 s into a 1-minute hold: waiting");
  f.state.now = T0 + 60_000;
  await f.service.tick();
  assert.equal(f.state.stops, 1, "at until: the hold has ended");

  const g = fixture();
  const { hold } = await g.service.hold({ heldBy: "factory", minutes: 30, reason: "long job" });
  await g.service.request("owner");
  await g.service.tick();
  assert.equal(g.state.stops, 0);
  const released = await g.service.releaseHold({ holdId: hold.holdId, by: "factory" });
  assert.equal(released.released, true);
  assert.equal(released.hold.active, false);
  await g.service.tick();
  assert.equal(g.state.stops, 1);
});

test("AC-RI-03: minutes must be 1-60 and a reason is required; anything else is validation_failed", async () => {
  const f = fixture();
  for (const minutes of [0, 61, 1.5, -1, "5", null, undefined]) {
    await rejects(f.service.hold({ heldBy: "factory", minutes, reason: "x" }), "validation_failed");
  }
  for (const reason of ["", "   ", undefined, 42, "x".repeat(201)]) {
    await rejects(f.service.hold({ heldBy: "factory", minutes: 5, reason }), "validation_failed");
  }
  assert.equal(f.state.holds.length, 0);
  assert.equal((await f.service.hold({ heldBy: "factory", minutes: 1, reason: "ok" })).hold.until, "2026-10-24T10:01:00.000Z");
  assert.equal((await f.service.hold({ heldBy: "factory", minutes: 60, reason: "x".repeat(200) })).hold.until, "2026-10-24T11:00:00.000Z");
});

test("AC-RI-04: a worker releases only its own hold, the Operator only its own (not_found otherwise); the owner any", async () => {
  const f = fixture();
  const a = (await f.service.hold({ heldBy: "worker:UC_A", minutes: 10, reason: "A" })).hold.holdId;
  const b = (await f.service.hold({ heldBy: "worker:UC_B", minutes: 10, reason: "B" })).hold.holdId;
  const op = (await f.service.hold({ heldBy: "factory", minutes: 10, reason: "Operator" })).hold.holdId;
  await rejects(f.service.releaseHold({ holdId: b, by: "worker:UC_A" }), "not_found");
  await rejects(f.service.releaseHold({ holdId: op, by: "worker:UC_A" }), "not_found");
  await rejects(f.service.releaseHold({ holdId: a, by: "factory" }), "not_found");
  await rejects(f.service.releaseHold({ holdId: "no-such-hold", by: "owner" }), "not_found");
  assert.equal((await f.service.releaseHold({ holdId: a, by: "worker:UC_A" })).released, true);
  assert.equal((await f.service.releaseHold({ holdId: op, by: "factory" })).released, true);
  const byOwner = await f.service.releaseHold({ holdId: b, by: "owner" });
  assert.equal(byOwner.released, true);
  assert.equal(byOwner.hold.releasedBy, "owner");
  assert.deepEqual((await f.service.status()).holds, []);
});

test("AC-RI-05: the owner cancels an open request; with none open, cancel is not_found", async () => {
  const f = fixture();
  await f.service.request("owner");
  const { request } = await f.service.cancel();
  assert.equal(request.status, "cancelled");
  await f.service.tick();
  assert.equal(f.state.stops, 0);
  assert.equal((await f.service.status()).request, null);
  await rejects(f.service.cancel(), "not_found");
});

test("AC-RI-05: a request open for 24 h becomes expired and does not restart", async () => {
  const f = fixture();
  f.busy.uploads = ["U1"];
  await f.service.request("owner");
  f.state.now = T0 + 24 * 60 * MIN - 1;
  await f.service.tick();
  assert.equal(f.state.requests[0].status, "open", "a millisecond before 24 h: still open");
  f.busy.uploads = [];
  f.state.now = T0 + 24 * 60 * MIN;
  // The status is a read: it shows no request past 24 h and changes nothing; the check marks it expired.
  assert.equal((await f.service.status()).request, null);
  assert.equal(f.state.requests[0].status, "open");
  await f.service.tick();
  assert.equal(f.state.requests[0].status, "expired");
  assert.equal(f.state.stops, 0);
});

test("AC-RI-05: a second request joins the open one", async () => {
  const f = fixture();
  f.busy.uploads = ["U1"];
  const first = await f.service.request("owner");
  const second = await f.service.request("developer");
  assert.equal(first.joined, false);
  assert.equal(second.joined, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(f.state.requests.length, 1);
});

test("AC-RI-06: on boot a restarting request becomes done with the running version and schema, shown as lastRestart", async () => {
  const f = fixture();
  await f.service.request("owner");
  f.state.now = T0 + 4 * MIN;
  await f.service.tick();
  assert.equal(f.state.stops, 1);

  // The next run (a new process): a new build.
  const next = fixture();
  next.state.requests = f.state.requests;
  next.state.build = { version: "0.9.0 (fedcba654321)", schema: 109 };
  next.state.now = T0 + 6 * MIN;
  assert.deepEqual(await next.service.finalizeBoot(), { finished: ["id-1"] });
  const last = (await next.service.status()).lastRestart;
  assert.deepEqual(
    last && { status: last.status, fromVersion: last.fromVersion, fromSchema: last.fromSchema, toVersion: last.toVersion, toSchema: last.toSchema, finishedAt: last.finishedAt, waitedMinutes: last.waitedMinutes, requestedBy: last.requestedBy },
    { status: "done", fromVersion: "0.9.0 (abc123def456)", fromSchema: 108, toVersion: "0.9.0 (fedcba654321)", toSchema: 109, finishedAt: "2026-10-24T10:06:00.000Z", waitedMinutes: 4, requestedBy: "owner" }
  );
  assert.equal((await next.service.status()).request, null);
});

test("AC-RI-06 (boot): a request still open when the server started again is done too -- it does not restart a second time", async () => {
  const f = fixture();
  f.busy.uploads = ["U1"];
  await f.service.request("developer");
  const next = fixture();
  next.state.requests = f.state.requests;
  next.state.now = T0 + 10 * MIN;
  await next.service.finalizeBoot();
  assert.equal(next.state.requests[0].status, "done");
  await next.service.tick();
  assert.equal(next.state.stops, 0);
});

test("AC-RI-07: outside the system service a request is refused (restart_needs_service) and nothing is stopped; status still works", async () => {
  const f = fixture({ serviceMode: false });
  await rejects(f.service.request("owner"), "restart_needs_service");
  await f.service.tick();
  assert.equal(f.state.stops, 0);
  assert.equal(f.state.requests.length, 0);
  const status = await f.service.status();
  assert.equal(status.serviceMode, false);
  assert.equal(status.request, null);
  assert.equal(status.quietMinutes, 3);
  // The developer's file is refused the same way (logged), never a restart.
  f.state.file = JSON.stringify({ requestedBy: "developer", at: "2026-10-24T09:59:00.000Z" });
  await f.service.tick();
  assert.equal(f.state.stops, 0);
  assert.equal(f.state.requests.length, 0);
  assert.ok(f.state.logs.some((entry) => entry.event === "restart_when_idle.request_file_refused"));
});

test("AC-RI-08: quiet minutes accept 1-30 (default 3) and apply to the next check", async () => {
  const f = fixture();
  assert.equal(await f.service.getQuietMinutes(), 3);
  for (const bad of [0, 31, 2.5, "5", null]) await rejects(f.service.setQuietMinutes(bad), "validation_failed");
  assert.deepEqual(await f.service.setQuietMinutes(1), { quietMinutes: 1 });
  assert.deepEqual(await f.service.setQuietMinutes(30), { quietMinutes: 30 });

  // Default 3: a call 2:59 ago blocks, one exactly 3:00 ago does not.
  const g = fixture();
  g.busy.lastMcpCallAt = T0 - (3 * MIN - 1000);
  await g.service.request("owner");
  await g.service.tick();
  assert.equal(g.state.stops, 0);
  g.busy.lastMcpCallAt = T0 - 3 * MIN;
  await g.service.tick();
  assert.equal(g.state.stops, 1);

  // A call 4 minutes ago: waits under 5 quiet minutes, restarts at the next check after the setting becomes 4.
  const h = fixture();
  h.busy.lastMcpCallAt = T0 - 4 * MIN;
  await h.service.setQuietMinutes(5);
  await h.service.request("owner");
  await h.service.tick();
  assert.equal(h.state.stops, 0);
  await h.service.setQuietMinutes(4);
  await h.service.tick();
  assert.equal(h.state.stops, 1);
});

test("AC-RI-09: the script's request file is taken up once and removed; a malformed file is removed and logged, and never restarts", async () => {
  const f = fixture();
  f.state.file = JSON.stringify({ requestedBy: "developer", at: "2026-10-24T09:59:30.000Z" });
  f.busy.uploads = ["U1"];
  await f.service.tick();
  assert.equal(f.state.file, null, "removed");
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].requestedBy, "developer");
  await f.service.tick();
  assert.equal(f.state.requests.length, 1, "taken up once");
  f.busy.uploads = [];
  await f.service.tick();
  assert.equal(f.state.stops, 1);

  for (const text of ["not json", "[]", JSON.stringify({ requestedBy: "owner", at: "2026-10-24T09:59:30.000Z" }), JSON.stringify({ requestedBy: "developer", at: "yesterday" }), JSON.stringify({ requestedBy: "developer" })]) {
    const g = fixture();
    g.state.file = text;
    await g.service.tick();
    assert.equal(g.state.file, null, text);
    assert.equal(g.state.requests.length, 0, text);
    assert.equal(g.state.stops, 0, text);
    assert.ok(g.state.logs.some((entry) => entry.event === "restart_when_idle.request_file_malformed"), text);
  }
});

test("AC-RI-09 (boot): a request file written before this start is satisfied by the start itself and removed", async () => {
  const f = fixture();
  f.state.file = JSON.stringify({ requestedBy: "developer", at: "2026-10-24T09:58:00.000Z" });
  await f.service.finalizeBoot();
  assert.equal(f.state.file, null);
  assert.equal(f.state.requests.length, 0);
  await f.service.tick();
  assert.equal(f.state.stops, 0);
});

test("AC-RI-05: a restart whose stop did not happen (still answering 5 minutes later) can be cancelled, and a new request stops again", async () => {
  const f = fixture();
  await f.service.request("owner");
  await f.service.tick();
  assert.equal(f.state.stops, 1);
  // Right after the stop there is nothing to cancel yet.
  await rejects(f.service.cancel(), "not_found");
  f.state.now = T0 + 5 * MIN;
  const cancelled = await f.service.cancel();
  assert.equal(cancelled.request.status, "cancelled");
  await f.service.request("owner");
  await f.service.tick();
  assert.equal(f.state.stops, 2);
});
