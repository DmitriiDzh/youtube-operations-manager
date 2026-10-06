import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret, decryptSecret } from "@/lib/shared-crypto";
import type { ComfyUiClient, RunpodApiClient, RunpodPod } from "@/lib/media-gateway";
import { MEDIA_SESSION_ACTIVE_STATUSES, DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSettings } from "./contracts";
import { createMediaSessionServices, type MediaSessionStore, type StoredSessionRow } from "./sessions";
import { createMemoryVolumeLockStore, createVolumeLock } from "./volume-lock";

/**
 * A lock whose holder is "active" exactly while held (no cross-module staleness check in these unit tests). Slice 6:
 * `activeSessions` is the database's "no active session" guard on an exclusive insert.
 */
function testLock(opts: { heldBy?: string; activeSessions?: () => number } = {}) {
  const store = createMemoryVolumeLockStore({ activeSessions: opts.activeSessions });
  if (opts.heldBy) void store.tryAcquire(opts.heldBy, new Date(0)); // an old, active holder
  return { lock: createVolumeLock({ store, isHolderActive: async () => true }), store };
}

// Expected behaviour from docs/roadmap/plans/PHASE_14_PLAN.md §2.3 and §4 (AC-P14-03, -04, -05,
// -06, -07, -08, -09, -17), written before this module. Expected numbers are computed by hand from
// the stated formulas (estimate = costPerHr × maxMinutes / 60; usd = seconds × costPerHr / 3600).

const KEY = Buffer.alloc(32, 5);
const READY_SETTINGS: MediaSettings = {
  ...DEFAULT_MEDIA_SETTINGS,
  datacenterId: "EU-RO-1",
  gpuTypeId: "NVIDIA GeForce RTX 4090",
  networkVolumeId: "vol-eu",
  templateId: "tpl1",
  gpuOnDemandPricePerHr: 0.6,
  maxUsdPerDay: 10,
  defaultMaxMinutes: 60,
  idleMinutes: 10,
  watchIntervalSeconds: 60,
};

const TERMINAL = new Set(["done", "failed", "rejected", "interrupted"]);

// The same set the database guard uses (BL-133 added `waiting_capacity`: no pod, but it keeps its concurrency slot).
const ACTIVE = new Set<string>(MEDIA_SESSION_ACTIVE_STATUSES);

/** `lockHeld` stands in for the approve UPDATE's "no exclusive volume-lock row" guard (slice 6). */
function memorySessionStore(opts: { lockHeld?: () => boolean } = {}) {
  const rows = new Map<string, StoredSessionRow>();
  const store: MediaSessionStore = {
    async insert(row) {
      const stored = { ...row, createdAt: row.createdAt ?? new Date() };
      rows.set(row.id, stored);
      return stored;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async listOpen() {
      return [...rows.values()].filter((r) => !TERMINAL.has(r.status));
    },
    async approve(id, set, maxActive) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return null;
      if ([...rows.values()].filter((r) => ACTIVE.has(r.status)).length >= maxActive) return null;
      if (opts.lockHeld?.()) return null;
      const next = { ...row, ...set, status: "approved" as const };
      rows.set(id, next);
      return next;
    },
    async list(limit, channelId) {
      return [...rows.values()].filter((r) => !channelId || r.channelId === channelId).slice(-limit).reverse();
    },
    async listBillableSince(since) {
      return [...rows.values()].filter((r) => r.startedAt && (r.stoppedAt === null || r.startedAt >= since || r.stoppedAt >= since));
    },
    async transition(id, from, set) {
      const row = rows.get(id);
      if (!row || !from.includes(row.status)) return null;
      const next = { ...row, ...set };
      rows.set(id, next);
      return next;
    },
    async touchActivity(id, at) {
      const row = rows.get(id);
      if (row && row.status === "running") rows.set(id, { ...row, lastActivityAt: at });
    },
    async markSeenAlive(id, at) {
      const row = rows.get(id);
      if (row && !TERMINAL.has(row.status)) rows.set(id, { ...row, lastSeenAliveAt: at });
    },
  };
  return { store, rows };
}

type PodState = { status: string; costPerHr: number };

function fakeRunpod(opts: { createFails?: boolean; runningAfterPolls?: number; terminateSticks?: boolean; containerNeverStarts?: boolean; capacity?: (input: { gpu?: { id: string } }) => boolean } = {}) {
  const pods = new Map<string, PodState>();
  const calls: string[] = [];
  let created = 0;
  let polls = 0;
  const pod = (id: string): RunpodPod => ({
    id,
    name: "ytm",
    status: pods.get(id)?.status ?? "TERMINATED",
    costPerHr: pods.get(id)?.costPerHr ?? null,
    dataCenterId: "EU-RO-1",
    gpuTypeId: "NVIDIA GeForce RTX 4090",
    gpuCount: 1,
    networkVolumeIds: ["vol-eu"],
    ports: null,
    // Like the live API: `RUNNING` + a runtime once the container is up; `containerNeverStarts` = RUNNING with no runtime.
    containerUptimeSec: pods.get(id)?.status === "RUNNING" && !opts.containerNeverStarts ? 5 : null,
    env: {},
    createdAt: null,
    startedAt: null,
    raw: {},
  });
  const client = {
    async createPod(input: { env?: Record<string, string>; gpu?: { id: string } }) {
      calls.push(`createPod:${input.gpu?.id ?? ""}`);
      calls.push("createPod");
      // BL-133 changed what a failed createPod means: "no capacity" and 5xx now WAIT for capacity; only a fatal answer
      // (balance, permission, a bad request) ends the start at once -- which is what these Phase-14 tests are about.
      if (opts.createFails) {
        const { DomainError } = await import("./contracts");
        throw new DomainError({ code: "runpod_api_unavailable", message: "RunPod API returned HTTP 422: the request body is not valid", details: { status: 422 } });
      }
      if (opts.capacity && opts.capacity(input as { gpu?: { id: string } })) {
        const { DomainError } = await import("./contracts");
        throw new DomainError({ code: "runpod_api_unavailable", message: "RunPod API returned HTTP 400: This GPU and data center combination could not be placed.", details: { status: 400 } });
      }
      created++;
      const id = `pod${created}`;
      pods.set(id, { status: "PROVISIONING", costPerHr: 0.69 });
      calls.push(`env:${input.env?.COMFY_TOKEN ?? ""}`);
      return pod(id);
    },
    async getPod(id: string) {
      calls.push(`getPod:${id}`);
      const state = pods.get(id);
      if (!state) return null;
      if (state.status === "PROVISIONING") {
        polls++;
        if (polls >= (opts.runningAfterPolls ?? 1)) state.status = "RUNNING";
      }
      return pod(id);
    },
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      // `terminateSticks`: the DELETE is accepted but the container lingers; a DELETE for a pod that is already gone is a
      // 404 (alreadyGone) in both modes, as RunPod answers.
      if (opts.terminateSticks) return { terminated: true as const, alreadyGone: !pods.has(id) };
      const existed = pods.delete(id);
      return { terminated: true as const, alreadyGone: !existed };
    },
    async listPods() {
      return [];
    },
  } as unknown as RunpodApiClient;
  return { client, calls, pods, setStatus: (id: string, status: string) => pods.set(id, { ...(pods.get(id) ?? { costPerHr: 0.69 }), status }) };
}

function fakeComfy(opts: { readyAfter?: number; never?: boolean } = {}) {
  let attempts = 0;
  const created: Array<{ baseUrl: string; token: string }> = [];
  const factory = (args: { baseUrl: string; token: string }) => {
    created.push(args);
    return {
      async getSystemStats() {
        attempts++;
        if (opts.never || attempts < (opts.readyAfter ?? 1)) {
          const { DomainError } = await import("./contracts");
          throw new DomainError({ code: "comfyui_unavailable", message: "ComfyUI returned HTTP 502" });
        }
        return { ok: true };
      },
    } as unknown as ComfyUiClient;
  };
  return { factory, created };
}

function fixture(opts: {
  settings?: Partial<MediaSettings>;
  ready?: boolean;
  runpod?: ReturnType<typeof fakeRunpod>;
  comfy?: ReturnType<typeof fakeComfy>;
  now?: Date;
  jobSummary?: (sessionId: string) => Promise<{ total: number; open: number; lastFinishedAt: Date | null }>;
} = {}) {
  const capacityLog: Array<{ gpuTypeId: string; result: string; detail: string | null }> = [];
  const events: Array<{ actor: string; action: string; subject: string; details?: Record<string, unknown> }> = [];
  const settings = { ...READY_SETTINGS, ...opts.settings };
  const runpod = opts.runpod ?? fakeRunpod();
  const comfy = opts.comfy ?? fakeComfy();
  // The two stores see each other the way the two guarded SQL statements do (slice 6).
  let lockStore: ReturnType<typeof createMemoryVolumeLockStore> | null = null;
  const mem = memorySessionStore({ lockHeld: () => lockStore?.current() != null });
  let now = opts.now ?? new Date("2026-10-05T10:00:00Z");
  const missing = opts.ready === false ? ["network volume"] : [];
  let idCounter = 0;
  const lock = testLock({ activeSessions: () => [...mem.rows.values()].filter((r) => ACTIVE.has(r.status)).length });
  lockStore = lock.store;
  const services = createMediaSessionServices({
    store: mem.store,
    base: {
      getSettings: async () => settings,
      getOverview: async () => ({ ready: missing.length === 0, missing, gatewayEnabled: true }),
      resolveRunpodClient: async () => runpod.client,
      sealSecret: async (text) => encryptSecret(text, KEY),
      openSecret: async (payload) => decryptSecret(payload, KEY),
    },
    createComfyClient: comfy.factory,
    comfyUiProxyBaseUrl: (podId, port) => `https://${podId}-${port}.example.test`,
    generateId: () => `session-${++idCounter}`,
    generateToken: () => "tok-abc",
    clock: { now: () => now },
    // Sleeping advances the fake clock, so start/stop timeouts are deterministic.
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    timeouts: { startMs: 60_000, pollMs: 5_000, stopMs: 20_000 },
    volumeLock: lock.lock,
    ...(opts.jobSummary ? { jobSummary: opts.jobSummary } : {}),
    capacityLog: { record: async (a) => void capacityLog.push({ gpuTypeId: a.gpuTypeId, result: a.result, detail: a.detail }) },
    events: { record: async (e) => void events.push(e) },
    awaitCapacityRetries: true,
  });
  /** AC-P14-18 observed directly: can a model pull take the volume right now? (It takes and gives back a probe lock.) */
  const pullCanTakeVolume = async (): Promise<boolean> => {
    try {
      await lock.lock.acquire("pull:probe");
    } catch {
      return false;
    }
    await lock.lock.release("pull:probe");
    return true;
  };
  return { services, mem, runpod, comfy, lock: lock.store, volumeLock: lock.lock, pullCanTakeVolume, settings, capacityLog, events, advance: (ms: number) => (now = new Date(now.getTime() + ms)), getNow: () => now };
}

/**
 * Slice 6: `watchTick` returns one result per open session (concurrent sessions, owner 2026-10-05). The tests written
 * for a single session read that one result; with no open session there is none ("none", as before).
 */
async function tick1(services: { watchTick(): Promise<Array<{ action: string; sessionId: string | null; reason: string | null }>> }) {
  return (await services.watchTick())[0] ?? { action: "none", sessionId: null, reason: null };
}

const operatorRequest = { channelId: "UC1", requestedBy: "operator" as const };

// -- AC-P14-03 -------------------------------------------------------------------------------------

test("AC-P14-03: the estimate is costPerHr × maxMinutes/60, computed locally with zero RunPod calls; fitsToday compares with the remaining cap", async () => {
  const { services, runpod } = fixture();
  const session = await services.requestSession({ ...operatorRequest, maxMinutes: 30 });
  assert.equal(session.estimateUsd, 0.3); // 0.6 $/h × 0.5 h
  assert.equal(session.fitsToday, true);
  assert.equal(session.status, "pending");
  assert.equal(session.costPerHr, 0.6);
  assert.deepEqual(runpod.calls, []);
});

test("AC-P14-03: a request that does not fit today is still created, flagged fitsToday=false; the default length comes from settings", async () => {
  const { services } = fixture({ settings: { maxUsdPerDay: 0.5, defaultMaxMinutes: 120 } });
  const session = await services.requestSession(operatorRequest);
  assert.equal(session.maxMinutes, 120);
  assert.equal(session.estimateUsd, 1.2);
  assert.equal(session.fitsToday, false);
});

test("a request is refused when the feature is not ready or the GPU price is unknown", async () => {
  const notReady = fixture({ ready: false });
  await assert.rejects(notReady.services.requestSession(operatorRequest), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  const noPrice = fixture({ settings: { gpuOnDemandPricePerHr: null } });
  await assert.rejects(noPrice.services.requestSession(operatorRequest), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
});

// -- AC-P14-05 -------------------------------------------------------------------------------------

// AC-P14-05 ("one non-terminal session per device") was superseded by the owner on 2026-10-05 (Telegram msgs 1549/1551/
// 1553, PHASE_14_PLAN.md §5.2): agents may request several sessions at once; the bound moved to approve
// (`maxConcurrentSessions`, AC-P14-22). The old test asserted the request-time conflict the requirement no longer has.
test("AC-P14-22: several requests may be pending at once; approves pass up to maxConcurrentSessions, the next is media_session_conflict with no pod", async () => {
  const f = fixture({ settings: { maxConcurrentSessions: 2, maxUsdPerDay: 100 } });
  const a = await f.services.requestSession(operatorRequest);
  const b = await f.services.requestSession({ ...operatorRequest, channelId: "UC2" });
  const c = await f.services.requestSession(operatorRequest);
  assert.equal(f.mem.rows.size, 3);
  assert.equal((await f.services.approveAndStartSession({ sessionId: a.sessionId })).status, "running");
  assert.equal((await f.services.approveAndStartSession({ sessionId: b.sessionId })).status, "running");
  const podsBefore = f.runpod.calls.filter((c) => c === "createPod").length;
  await assert.rejects(
    f.services.approveAndStartSession({ sessionId: c.sessionId }),
    (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /2 of 2 concurrent sessions/.test(e.message)
  );
  assert.equal(f.mem.rows.get(c.sessionId)!.status, "pending");
  assert.equal(f.runpod.calls.filter((c) => c === "createPod").length, podsBefore, "no pod for the refused approve");
  const limits = await f.services.getLimits();
  assert.equal(limits.maxConcurrentSessions, 2);
  assert.equal(limits.activeSessionCount, 2);
  assert.deepEqual(limits.openSessions.map((s) => s.sessionId), [a.sessionId, b.sessionId, c.sessionId]);
  assert.equal(limits.openSession?.sessionId, a.sessionId);
  // A finished session frees its place.
  await f.services.stopSession({ sessionId: a.sessionId });
  assert.equal((await f.services.approveAndStartSession({ sessionId: c.sessionId })).status, "running");
});

test("AC-P14-22: two approves racing for the last place -- exactly one wins, the other is refused and creates no pod", async () => {
  const f = fixture({ settings: { maxConcurrentSessions: 1, maxUsdPerDay: 100 } });
  const a = await f.services.requestSession(operatorRequest);
  const b = await f.services.requestSession(operatorRequest);
  const [ra, rb] = await Promise.allSettled([f.services.approveSession({ sessionId: a.sessionId }), f.services.approveSession({ sessionId: b.sessionId })]);
  const won = [ra, rb].filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1);
  const lost = [ra, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(isDomainError(lost.reason) && lost.reason.code === "media_session_conflict");
  await (won[0] as PromiseFulfilledResult<{ started: Promise<unknown> }>).value.started;
  assert.equal(f.runpod.calls.filter((c) => c === "createPod").length, 1);
});

test("AC-P14-24: approveSession returns at once with status approved; the start continues in the background and its failure lands on the row", async () => {
  const ok = fixture({ runpod: fakeRunpod({ runningAfterPolls: 3 }) });
  const requested = await ok.services.requestSession(operatorRequest);
  const { session, started } = await ok.services.approveSession({ sessionId: requested.sessionId, approvedByUserId: "u1" });
  assert.equal(session.status, "approved");
  assert.equal((await started).status, "running");
  assert.equal(ok.mem.rows.get(requested.sessionId)!.status, "running");

  const failing = fixture({ runpod: fakeRunpod({ createFails: true }) });
  const r2 = await failing.services.requestSession(operatorRequest);
  const approved = await failing.services.approveSession({ sessionId: r2.sessionId });
  assert.equal(approved.session.status, "approved");
  await assert.rejects(approved.started, (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = failing.mem.rows.get(r2.sessionId)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /pod creation failed/);
});

test("§5.2 daily cap with concurrent sessions: spent + what the other active sessions may still spend + this estimate must fit", async () => {
  // 0.6 $/h × 60 min = $0.60 estimate each, cap $1.50, a few seconds of live spend (rounds to $0.00):
  //   first:  0 spent + 0 reserved    + 0.60 = 0.60 ≤ 1.50 -> approved
  //   second: 0 spent + 0.60 reserved + 0.60 = 1.20 ≤ 1.50 -> approved
  //   third:  0 spent + 1.20 reserved + 0.60 = 1.80 > 1.50 -> media_daily_cap_reached
  const f = fixture({ settings: { maxConcurrentSessions: 4, maxUsdPerDay: 1.5 } });
  const a = await f.services.requestSession(operatorRequest);
  const b = await f.services.requestSession(operatorRequest);
  const c = await f.services.requestSession(operatorRequest);
  await f.services.approveAndStartSession({ sessionId: a.sessionId });
  await f.services.approveAndStartSession({ sessionId: b.sessionId });
  await assert.rejects(f.services.approveAndStartSession({ sessionId: c.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_daily_cap_reached" && /reserved by the other active sessions/.test(e.message));
  assert.equal(f.mem.rows.get(c.sessionId)!.status, "pending");
});

test("AC-P14-23: a model pull cannot take the volume while any session is active, and can once none is", async () => {
  const f = fixture({ settings: { maxConcurrentSessions: 2, maxUsdPerDay: 100 } });
  const a = await startRunning(f);
  const b = await startRunning(f);
  assert.equal(await f.pullCanTakeVolume(), false);
  await f.services.stopSession({ sessionId: a.sessionId });
  assert.equal(await f.pullCanTakeVolume(), false, "one session still active");
  await f.services.stopSession({ sessionId: b.sessionId });
  assert.equal(await f.pullCanTakeVolume(), true);
});

test("slice 6: the watcher, boot sweep and shutdown act on EVERY open session", async () => {
  const f = fixture({ settings: { maxConcurrentSessions: 3, maxUsdPerDay: 100, idleMinutes: 10 } });
  const a = await startRunning(f, { maxMinutes: 600 });
  const b = await startRunning(f, { maxMinutes: 600 });
  const pending = await f.services.requestSession(operatorRequest);
  f.advance(11 * 60_000);
  const ticks = await f.services.watchTick();
  assert.deepEqual(ticks.map((t) => [t.sessionId, t.action]), [[a.sessionId, "stopped"], [b.sessionId, "stopped"], [pending.sessionId, "none"]]);
  assert.equal(await f.services.hasOpenPod(), false);

  const g = fixture({ settings: { maxConcurrentSessions: 3, maxUsdPerDay: 100 } });
  const c = await startRunning(g);
  const d = await startRunning(g);
  assert.equal(await g.services.hasOpenPod(), true);
  assert.deepEqual((await g.services.stopForShutdown()).stopped.sort(), [c.sessionId, d.sessionId].sort());

  const h = fixture({ settings: { maxConcurrentSessions: 3, maxUsdPerDay: 100 } });
  const e1 = await startRunning(h);
  const e2 = await startRunning(h);
  assert.deepEqual((await h.services.bootSweep()).swept, [e1.sessionId, e2.sessionId]);
  assert.equal(h.mem.rows.get(e1.sessionId)!.status, "interrupted");
  assert.equal(h.mem.rows.get(e2.sessionId)!.status, "interrupted");
});

// -- AC-P14-04 / start -----------------------------------------------------------------------------

test("AC-P14-04: approve runs the preconditions before any transition -- a used-up cap leaves the request pending and creates no pod", async () => {
  const { services, runpod, mem } = fixture({ settings: { maxUsdPerDay: 0.1 } });
  // A finished session today already spent more than the cap.
  mem.rows.set("old", {
    ...(await services.requestSession({ ...operatorRequest, maxMinutes: 10 }).then(() => mem.rows.get("session-1")!)),
    id: "old",
    status: "done",
    startedAt: new Date("2026-10-05T08:00:00Z"),
    stoppedAt: new Date("2026-10-05T09:00:00Z"),
    secondsUsed: 3600,
    usdCharged: 0.69,
  });
  await assert.rejects(services.approveAndStartSession({ sessionId: "session-1", approvedByUserId: "u1" }), (e: unknown) => isDomainError(e) && e.code === "media_daily_cap_reached");
  assert.equal(mem.rows.get("session-1")?.status, "pending");
  assert.ok(!runpod.calls.includes("createPod"));
});

test("approve: pending -> approved -> starting -> running; the pod gets the token, the session gets the proxy URL, costPerHr from the pod, startedAt = creation time", async () => {
  const runpod = fakeRunpod({ runningAfterPolls: 2 });
  const comfy = fakeComfy({ readyAfter: 2 });
  const { services, mem, getNow } = fixture({ runpod, comfy });
  const stages: string[] = [];
  const requested = await services.requestSession({ ...operatorRequest, maxMinutes: 45 });
  const t0 = getNow();
  const running = await services.approveAndStartSession({ sessionId: requested.sessionId, approvedByUserId: "u1", onStage: (s) => stages.push(s) });
  assert.equal(running.status, "running");
  assert.equal(running.podId, "pod1");
  assert.equal(running.comfyUiProxyUrl, "https://pod1-8189.example.test");
  assert.equal(running.costPerHr, 0.69);
  assert.equal(running.startedAt, t0.toISOString());
  assert.ok(running.readyAt && running.readyAt > running.startedAt);
  assert.equal(running.lastActivityAt, running.readyAt);
  assert.ok(runpod.calls.includes("env:tok-abc"));
  assert.deepEqual(comfy.created, [{ baseUrl: "https://pod1-8189.example.test", token: "tok-abc" }]);
  assert.deepEqual(stages, ["Creating the pod", "Waiting for the pod to run", "Waiting for ComfyUI to answer"]);
  // The token is stored encrypted and never in the public shape.
  const row = mem.rows.get(requested.sessionId)!;
  assert.ok(row.tokenCiphertext && row.tokenCiphertext !== "tok-abc");
  assert.ok(!JSON.stringify(running).includes("tok-abc"));
  const client = await services.comfyClientForSession(requested.sessionId);
  assert.ok(client);
  assert.equal(comfy.created[1].token, "tok-abc");
});

test("AC-P14-07: a start that never becomes ready terminates the pod and ends the session failed, pod confirmed gone", async () => {
  const runpod = fakeRunpod();
  const comfy = fakeComfy({ never: true });
  const { services, mem } = fixture({ runpod, comfy });
  const requested = await services.requestSession(operatorRequest);
  await assert.rejects(services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.ok(runpod.calls.includes("terminate:pod1"));
  assert.equal(runpod.pods.has("pod1"), false);
  assert.ok(row.secondsUsed !== null && row.secondsUsed >= 60);
  assert.match(row.error ?? "", /start failed/);
});

test("a pod creation failure ends the session failed with the reason and no pod", async () => {
  const runpod = fakeRunpod({ createFails: true });
  const { services, mem } = fixture({ runpod });
  const requested = await services.requestSession(operatorRequest);
  await assert.rejects(services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, null);
  assert.equal(row.usdCharged, 0);
  assert.match(row.error ?? "", /pod creation failed/);
});

test("approve of a non-pending session is media_session_invalid_state; reject only from pending", async () => {
  const { services } = fixture();
  const requested = await services.requestSession(operatorRequest);
  const rejected = await services.rejectSession({ sessionId: requested.sessionId, reason: "not now" });
  assert.equal(rejected.status, "rejected");
  await assert.rejects(services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  await assert.rejects(services.rejectSession({ sessionId: requested.sessionId, reason: "again" }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  await assert.rejects(services.getSession({ sessionId: "nope" }), (e: unknown) => isDomainError(e) && e.code === "media_session_not_found");
});

// -- AC-P14-06 / AC-P14-17 (watcher, cost) ---------------------------------------------------------

async function startRunning(f: ReturnType<typeof fixture>, request: Record<string, unknown> = {}) {
  const requested = await f.services.requestSession({ ...operatorRequest, ...request });
  return f.services.approveAndStartSession({ sessionId: requested.sessionId, approvedByUserId: "u1" });
}

test("AC-P14-06: the watcher terminates on idle ≥ idleMinutes; activity restarts the idle clock", async () => {
  const f = fixture({ settings: { idleMinutes: 10 } });
  const running = await startRunning(f, { maxMinutes: 600 });
  f.advance(9 * 60_000);
  assert.equal((await tick1(f.services)).action, "none");
  await f.services.touchActivity(running.sessionId);
  f.advance(9 * 60_000);
  assert.equal((await tick1(f.services)).action, "none");
  f.advance(2 * 60_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /idle/);
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "done");
  assert.equal(f.runpod.pods.has("pod1"), false);
});

test("AC-P14-06: the watcher terminates at maxMinutes and at maxUsd", async () => {
  const byMinutes = fixture({ settings: { idleMinutes: 1000 } });
  const a = await startRunning(byMinutes, { maxMinutes: 30 });
  byMinutes.advance(29 * 60_000);
  assert.equal((await tick1(byMinutes.services)).action, "none");
  byMinutes.advance(2 * 60_000);
  const tickA = await tick1(byMinutes.services);
  assert.equal(tickA.action, "stopped");
  assert.match(tickA.reason ?? "", /max minutes/);
  assert.equal(byMinutes.mem.rows.get(a.sessionId)!.status, "done");

  const byUsd = fixture({ settings: { idleMinutes: 1000 } });
  const b = await startRunning(byUsd, { maxMinutes: 600, maxUsd: 0.5 });
  // 0.69 $/h: $0.5 is reached after ~43.5 min.
  byUsd.advance(40 * 60_000);
  assert.equal((await tick1(byUsd.services)).action, "none");
  byUsd.advance(5 * 60_000);
  const tickB = await tick1(byUsd.services);
  assert.equal(tickB.action, "stopped");
  assert.match(tickB.reason ?? "", /max USD/);
  assert.equal(byUsd.mem.rows.get(b.sessionId)!.status, "done");
});

test("AC-P14-17: usdCharged = secondsUsed × costPerHr / 3600 from pod creation to confirmed termination; the live value counts while running", async () => {
  const f = fixture({ settings: { idleMinutes: 1000 } });
  const running = await startRunning(f, { maxMinutes: 600 });
  f.advance(30 * 60_000);
  const live = await f.services.getSession({ sessionId: running.sessionId });
  assert.ok(live.secondsUsed !== null && live.secondsUsed >= 1800);
  const stopped = await f.services.stopSession({ sessionId: running.sessionId, reason: "done for today" });
  assert.equal(stopped.status, "done");
  assert.equal(stopped.stopReason, "done for today");
  // seconds: 30 min + the start polls (5 s each) = 1805 s at 0.69 $/h -> $0.35 (rounded to cents)
  assert.equal(stopped.secondsUsed, 1805);
  assert.equal(stopped.usdCharged, Math.round(((1805 * 0.69) / 3600) * 100) / 100);
  const limits = await f.services.getLimits();
  assert.equal(limits.spentTodayUsd, stopped.usdCharged);
  assert.equal(limits.openSession, null);
});

test("AC-P14-07: a pod found EXITED is terminated and the session marked interrupted; a vanished pod marks interrupted; the app never calls stop", async () => {
  const exited = fixture();
  const a = await startRunning(exited);
  exited.runpod.setStatus("pod1", "EXITED");
  const tickA = await tick1(exited.services);
  assert.equal(tickA.action, "interrupted");
  assert.equal(exited.mem.rows.get(a.sessionId)!.status, "interrupted");
  assert.ok(exited.runpod.calls.includes("terminate:pod1"));
  assert.ok(!Object.keys(exited.runpod.client).includes("stopPod"));

  const gone = fixture();
  const b = await startRunning(gone);
  gone.runpod.pods.delete("pod1");
  const tickB = await tick1(gone.services);
  assert.equal(tickB.action, "interrupted");
  assert.equal(gone.mem.rows.get(b.sessionId)!.status, "interrupted");
});

test("AC-P14-07: when the API cannot confirm termination the session stays stopping and the watcher retries", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod, settings: { idleMinutes: 1 } });
  const running = await startRunning(f, { maxMinutes: 600 });
  f.advance(2 * 60_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "retried_stop");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "stopping");
  assert.equal((await f.services.getLimits()).openSession?.status, "stopping");
  // Later the pod really goes away.
  f.runpod.pods.delete("pod1");
  const retry = await tick1(f.services);
  assert.equal(retry.action, "stopped");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "done");
});

// -- AC-P14-08 / AC-P14-09 -------------------------------------------------------------------------

test("AC-P14-08: the boot sweep terminates a pod left by a dead process and marks the session interrupted; a pending request stays", async () => {
  const f = fixture();
  const running = await startRunning(f);
  const swept = await f.services.bootSweep();
  assert.deepEqual(swept, { swept: [running.sessionId] });
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "interrupted");
  assert.equal(f.runpod.pods.has("pod1"), false);
  assert.ok(row.usdCharged !== null);

  const pendingOnly = fixture();
  await pendingOnly.services.requestSession(operatorRequest);
  assert.deepEqual(await pendingOnly.services.bootSweep(), { swept: [] });
  assert.equal((await pendingOnly.services.getLimits()).openSession?.status, "pending");
});

test("AC-P14-09: shutdown terminates the running pod first (bounded) and never throws", async () => {
  const f = fixture();
  const running = await startRunning(f);
  // Slice 6: `stopped` lists every session whose termination was confirmed (several may run at once).
  assert.deepEqual(await f.services.stopForShutdown(), { stopped: [running.sessionId] });
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "done");
  assert.equal(f.mem.rows.get(running.sessionId)!.stopReason, "application shutdown");
  assert.deepEqual(await f.services.stopForShutdown(), { stopped: [] });

  const sticky = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const s = await startRunning(sticky);
  assert.deepEqual(await sticky.services.stopForShutdown(), { stopped: [] });
  assert.equal(sticky.mem.rows.get(s.sessionId)!.status, "stopping");
});

test("stopSession on a pending session is invalid; after done, comfyClientForSession is refused", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.stopSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  await f.services.stopSession({ sessionId: requested.sessionId });
  await assert.rejects(f.services.comfyClientForSession(requested.sessionId), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
});

test("AC-P14-18: approve is refused while a model pull is writing to the volume; the request stays pending and no pod is created", async () => {
  const runpod = fakeRunpod();
  const mem = memorySessionStore();
  let now = new Date("2026-10-05T10:00:00Z");
  const services = createMediaSessionServices({
    store: mem.store,
    base: {
      getSettings: async () => READY_SETTINGS,
      getOverview: async () => ({ ready: true, missing: [], gatewayEnabled: true }),
      resolveRunpodClient: async () => runpod.client,
      sealSecret: async (text) => encryptSecret(text, KEY),
      openSecret: async (payload) => decryptSecret(payload, KEY),
    },
    createComfyClient: fakeComfy().factory,
    comfyUiProxyBaseUrl: (podId, port) => `https://${podId}-${port}.example.test`,
    generateId: () => "session-pull",
    generateToken: () => "tok",
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    volumeLock: testLock({ heldBy: "pull:p1" }).lock, // a running model pull holds the volume lock
  });
  const requested = await services.requestSession(operatorRequest);
  await assert.rejects(services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /model pull \(p1\)/.test(e.message));
  const row = mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "pending");
  assert.equal(row.approvedAt, null);
  assert.equal(row.tokenCiphertext, null);
  assert.ok(!runpod.calls.includes("createPod"));
});

// -- review round 1 (2026-10-05) ------------------------------------------------------------------

test("review: approve is refused when the session's own estimate does not fit today's remaining cap (AC-P14-17: daily totals drive the cap)", async () => {
  const f = fixture({ settings: { maxUsdPerDay: 1 } });
  // 0.6 $/h × 120 min = $1.20 > $1 cap, nothing spent yet.
  const requested = await f.services.requestSession({ ...operatorRequest, maxMinutes: 120 });
  assert.equal(requested.fitsToday, false);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_daily_cap_reached");
  assert.equal(f.mem.rows.get(requested.sessionId)?.status, "pending");
  assert.ok(!f.runpod.calls.includes("createPod"));
});

test("review: the watcher terminates a running session once the day's total spend reaches the daily cap", async () => {
  // Cap $0.42; the request's estimate (0.6 $/h × 40 min = $0.40) fits, but the pod's real price is 0.69 $/h.
  const f = fixture({ settings: { maxUsdPerDay: 0.42, idleMinutes: 1000 } });
  const running = await startRunning(f, { maxMinutes: 40 });
  f.advance(35 * 60_000); // 0.69 $/h × 35 min ≈ $0.40 < $0.42
  assert.equal((await tick1(f.services)).action, "none");
  f.advance(3 * 60_000); // ≈ $0.44 ≥ $0.42, still under maxMinutes (40)
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /daily cap/);
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "done");
});

test("review: a RunPod outage while polling the new pod never leaves it behind -- terminated and the session failed", async () => {
  // Review round 17: a single blip is tolerated (see the round-17 test); it takes a RUN of failures to abort -- and then
  // the pod is still terminated, never left behind.
  const runpod = fakeRunpod();
  const original = runpod.client.getPod.bind(runpod.client);
  let polls = 0;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    polls++;
    if (polls <= 5) {
      const { DomainError } = await import("./contracts");
      throw new DomainError({ code: "runpod_api_unavailable", message: "RunPod API returned HTTP 502" });
    }
    return original(id);
  };
  const f = fixture({ runpod });
  const requested = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod1");
  assert.ok(runpod.calls.includes("terminate:pod1"));
  assert.equal(runpod.pods.has("pod1"), false);
});

test("review: when termination cannot be confirmed after a failed start, the session stays `stopping` with the pod recorded, and the watcher retries", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const comfy = fakeComfy({ never: true });
  const f = fixture({ runpod, comfy });
  const requested = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "stopping");
  assert.equal(row.podId, "pod1");
  assert.equal((await f.services.getLimits()).openSession?.status, "stopping");
  f.runpod.pods.delete("pod1");
  assert.equal((await tick1(f.services)).action, "stopped");
  // Review round 6: AC-P14-07 says a start that fails ends the session `failed` -- the earlier expectation of `done`
  // here described the defect (a retried stop defaulting to `done`), not the requirement.
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "failed");
});

test("review: an operator Stop during the start wait is not overwritten by the start loop's own failure path", async () => {
  const runpod = fakeRunpod({ runningAfterPolls: 3 });
  const f = fixture({ runpod });
  const requested = await f.services.requestSession(operatorRequest);
  const original = runpod.client.getPod.bind(runpod.client);
  let stopped = false;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    if (!stopped) {
      stopped = true;
      await f.services.stopSession({ sessionId: requested.sessionId, reason: "stopped by operator" }); // the Web Stop button, mid-start
    }
    return original(id);
  };
  // Review round 19: an intentional Stop while starting is the session's outcome, not a start failure -- the approve
  // request resolves with that outcome instead of reporting an error.
  const outcome = await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.equal(outcome.status, "done");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "done");
  assert.equal(row.stopReason, "stopped by operator");
  assert.equal(runpod.pods.has("pod1"), false);
});

// -- review round 2 (2026-10-05) ------------------------------------------------------------------

test("review 2: the boot sweep never frees the slot while the pod's termination is unconfirmed -- the session goes to `stopping` with its podId and the watcher retries", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod });
  const running = await startRunning(f);
  assert.deepEqual(await f.services.bootSweep(), { swept: [running.sessionId] });
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "stopping");
  assert.equal(row.podId, "pod1");
  assert.equal((await f.services.getLimits()).openSession?.sessionId, running.sessionId);
  f.runpod.pods.delete("pod1");
  assert.equal((await tick1(f.services)).action, "stopped");
  // Review round 6: AC-P14-08 says a session reconciled by the boot sweep is `interrupted`; the earlier `done` here
  // was the defect (the retry lost the sweep's outcome), not the requirement.
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "interrupted");

  const unreachable = fixture();
  const s = await startRunning(unreachable);
  (unreachable.runpod.client as { terminatePod: (id: string) => Promise<unknown> }).terminatePod = async () => {
    throw new Error("RunPod API returned HTTP 502");
  };
  await unreachable.services.bootSweep();
  assert.equal(unreachable.mem.rows.get(s.sessionId)!.status, "stopping");
});

test("review 2: the estimate is min(price × minutes / 60, maxUsd), so a tight maxUsd fits the daily cap", async () => {
  const f = fixture({ settings: { maxUsdPerDay: 1 } });
  const session = await f.services.requestSession({ ...operatorRequest, maxMinutes: 600, maxUsd: 0.8 });
  assert.equal(session.estimateUsd, 0.8); // 0.6 × 10 h = $6 capped by maxUsd
  assert.equal(session.fitsToday, true);
  const started = await f.services.approveAndStartSession({ sessionId: session.sessionId });
  assert.equal(started.status, "running");
});

test("review 2: today's spend includes a session that started before midnight and is still open or stopped today", async () => {
  const f = fixture({ now: new Date("2026-10-05T23:30:00Z"), settings: { idleMinutes: 1000 } });
  const a = await startRunning(f, { maxMinutes: 600 });
  f.advance(2 * 60 * 60_000); // now 01:30 next day, A still running: 0.69 × 2 h ≈ $1.38
  const limits = await f.services.getLimits();
  assert.ok(limits.spentTodayUsd >= 1.3, `spent today should include the open session, got ${limits.spentTodayUsd}`);
  await f.services.stopSession({ sessionId: a.sessionId });
  const after = await f.services.getLimits();
  assert.ok(after.spentTodayUsd >= 1.3, "a session stopped today still counts");
});

test("review 2: a pod created but never written as `starting` is still recorded (podId, startedAt, cost) on the failed row", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  const originalTransition = f.mem.store.transition;
  let failedOnce = false;
  f.mem.store.transition = async (id, from, set) => {
    if (set.status === "starting" && !failedOnce) {
      failedOnce = true;
      throw new Error("SQLITE_BUSY");
    }
    return originalTransition(id, from, set);
  };
  f.advance(60_000);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod1");
  assert.ok(row.startedAt);
  assert.equal(row.costPerHr, 0.69);
  assert.ok((row.secondsUsed ?? 0) >= 0 && row.usdCharged !== null);
  assert.equal(f.runpod.pods.has("pod1"), false);
});

// -- review round 3 (2026-10-05) ------------------------------------------------------------------

test("review 3: a pod created before the `starting` write (process died in between) is found by its deterministic name at boot and terminated", async () => {
  const runpod = fakeRunpod();
  const f = fixture({ runpod });
  const requested = await f.services.requestSession(operatorRequest);
  // Simulate the crash: the pod exists under the session's name, the row is still `approved` with no podId.
  await runpod.client.createPod({ name: `ytm-media-${requested.sessionId.slice(0, 8)}` } as never);
  (runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => [{ id: "pod1", name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING" }];
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "approved", approvedAt: new Date() });
  assert.deepEqual(await f.services.bootSweep(), { swept: [requested.sessionId] });
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "interrupted");
  assert.equal(f.mem.rows.get(requested.sessionId)!.podId, "pod1");
  assert.equal(runpod.pods.has("pod1"), false);
});

// -- review round 5 (2026-10-05) ------------------------------------------------------------------

test("review 5: a createPod call that fails after RunPod created the pod continues with the pod found by its name (never an orphan)", async () => {
  const runpod = fakeRunpod();
  const f = fixture({ runpod });
  const requested = await f.services.requestSession(operatorRequest);
  const originalCreate = runpod.client.createPod.bind(runpod.client);
  (runpod.client as { createPod: (input: unknown) => Promise<unknown> }).createPod = async (input: unknown) => {
    await originalCreate(input as never); // RunPod did create it...
    throw new Error("RunPod API request failed: The operation was aborted due to timeout"); // ...but the response was lost
  };
  (runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => [{ id: "pod1", name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING" }];
  const running = await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.equal(running.status, "running");
  assert.equal(running.podId, "pod1");
});

test("review 5: a pod that dies while ComfyUI is booting aborts the start within one poll, not after the whole budget", async () => {
  const runpod = fakeRunpod();
  const comfy = fakeComfy({ never: true });
  const f = fixture({ runpod, comfy });
  const requested = await f.services.requestSession(operatorRequest);
  const original = runpod.client.getPod.bind(runpod.client);
  let polls = 0;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    polls++;
    if (polls === 3) runpod.setStatus("pod1", "ERROR");
    return original(id);
  };
  const before = f.getNow().getTime();
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
  assert.ok(f.getNow().getTime() - before < 60_000, "aborted well before the 60 s test budget");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /pod ERROR while waiting for ComfyUI/);
});

// -- review round 6 (2026-10-05) ------------------------------------------------------------------

test("review 6: a session left `starting` by an approve request that died is reconciled by the watcher once unmistakably abandoned -- pod terminated, session failed, cost recorded", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  // The approving request died right after the `starting` write (a non-DomainError escaped): pod1 bills, nobody polls it.
  await f.runpod.client.createPod({ name: `ytm-media-${requested.sessionId.slice(0, 8)}`, env: {} } as never);
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "starting", podId: "pod1", approvedAt: f.getNow(), startedAt: f.getNow(), costPerHr: 0.69 });
  // Inside the start budget (60 s) + stop budget (20 s) + grace (300 s, review round 9) the approve may still be running: hands off.
  f.advance(370_000);
  assert.equal((await tick1(f.services)).action, "none");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "starting");
  assert.ok(f.runpod.pods.has("pod1"));
  // Past it, the pod can only be an orphan.
  f.advance(20_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /start abandoned/);
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(f.runpod.pods.has("pod1"), false);
  assert.equal(row.secondsUsed, 390);
  assert.equal(row.usdCharged, 0.07); // 390 s × 0.69 / 3600 = 0.07475
  assert.equal(await f.services.hasOpenPod(), false, "the idle shutdown is no longer blocked");
});

test("review 6: an `approved` row without podId is never moved to `stopping` while RunPod is unreachable -- the deterministic-name search is kept for a later tick/boot, then the pod is found and terminated", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  const pod = await f.runpod.client.createPod({ name: `ytm-media-${requested.sessionId.slice(0, 8)}`, env: {} } as never);
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "approved", approvedAt: f.getNow() });
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => [{ ...pod, name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING" }];
  const listPods = f.runpod.client.listPods;
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => {
    throw new Error("RunPod API returned HTTP 503");
  };
  // Boot while RunPod is down.
  assert.deepEqual(await f.services.bootSweep(), { swept: [requested.sessionId] });
  let row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "approved", "stays approved so the name search still triggers");
  assert.equal(row.podId, null);
  assert.match(row.error ?? "", /could not check RunPod/);
  assert.equal(await f.services.hasOpenPod(), true, "the slot stays taken while a pod may bill");
  // A watcher tick with RunPod still down (and the row already abandoned by age): still deferred, nothing finished.
  f.advance(10 * 60_000);
  assert.equal((await tick1(f.services)).action, "none");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "approved");
  // RunPod is back: the pod is found by name, terminated, the cost recorded.
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = listPods;
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod1");
  assert.equal(f.runpod.pods.has("pod1"), false);
});

test("review 6: a stop retried from `stopping` finishes with the outcome it was started for -- `failed` for an aborted start, `done` with the original reason for an operator/watcher stop swept at boot", async () => {
  // Aborted start whose termination could not be confirmed -> stopping; the retry must NOT report `done`.
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod, comfy: fakeComfy({ never: true }) });
  const requested = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }));
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "stopping");
  f.runpod.pods.delete("pod1");
  await tick1(f.services);
  const aborted = f.mem.rows.get(requested.sessionId)!;
  assert.equal(aborted.status, "failed");
  assert.match(aborted.stopReason ?? "", /start failed/);
  assert.equal(aborted.readyAt, null);

  // Watcher stop (max USD) whose termination hung -> stopping; a restart's boot sweep keeps the reason and ends `done`.
  const g = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(g, { maxMinutes: 600, maxUsd: 0.05 });
  g.advance(10 * 60_000); // 600 s × 0.69 / 3600 = 0.115 ≥ 0.05
  assert.equal((await tick1(g.services)).action, "retried_stop");
  assert.equal(g.mem.rows.get(running.sessionId)!.status, "stopping");
  g.runpod.pods.delete("pod1");
  await g.services.bootSweep();
  const swept = g.mem.rows.get(running.sessionId)!;
  assert.equal(swept.status, "done");
  assert.equal(swept.stopReason, "max USD reached ($0.05)");
});

test("review 6: a pod found EXITED whose termination cannot be confirmed keeps the session `stopping` (podId kept) and ends `interrupted` once confirmed", async () => {
  const f = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(f);
  f.runpod.setStatus("pod1", "EXITED");
  assert.equal((await tick1(f.services)).action, "retried_stop");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "stopping");
  f.runpod.pods.delete("pod1");
  assert.equal((await tick1(f.services)).action, "stopped");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "interrupted");
});

test("review 6: listSessions filters by channel in the store query, so a channel's sessions are found behind any number of another channel's", async () => {
  const f = fixture();
  const mine = await f.services.requestSession({ channelId: "UC_A", requestedBy: "operator" });
  await f.services.rejectSession({ sessionId: mine.sessionId, reason: "later" });
  for (let i = 0; i < 60; i++) {
    const other = await f.services.requestSession({ channelId: "UC_B", requestedBy: "operator" });
    await f.services.rejectSession({ sessionId: other.sessionId, reason: "x" });
  }
  const page = await f.services.listSessions(50);
  assert.ok(!page.some((s) => s.channelId === "UC_A"), "a capped page without the filter would hide it");
  const filtered = await f.services.listSessions(20, "UC_A");
  assert.deepEqual(filtered.map((s) => s.sessionId), [mine.sessionId]);
});

// -- review round 7 (2026-10-05) ------------------------------------------------------------------

test("review 7: a pod found ALREADY gone at the boot sweep is billed until the app last saw it alive, not until the reboot (AC-P14-08/17); a pod still alive is billed to its confirmed termination", async () => {
  const f = fixture();
  const running = await startRunning(f); // startedAt = T0; the start loop's one 5 s poll puts readiness at T0+5s
  const started = f.mem.rows.get(running.sessionId)!.startedAt!.getTime();
  assert.equal(f.getNow().getTime(), started + 5_000);
  f.advance(5 * 60_000);
  assert.equal((await tick1(f.services)).action, "none"); // the watcher sees the pod alive at T0+5s+5min
  assert.equal(f.mem.rows.get(running.sessionId)!.lastSeenAliveAt?.getTime(), started + 305_000);
  // The process dies; the operator kills the pod by hand a minute later; the server comes back 6 hours on.
  f.runpod.pods.delete("pod1");
  f.advance(6 * 60 * 60_000);
  await f.services.bootSweep();
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "interrupted");
  assert.equal(row.secondsUsed, 305, "305 s seen alive, not 6 h");
  assert.equal(row.usdCharged, 0.06); // 305 × 0.69 / 3600 = 0.0585
  assert.match(row.error ?? "", /already gone; billed until it was last seen alive/);
  assert.ok((await f.services.getLimits()).remainingTodayUsd > 9, "the daily cap is not eaten by phantom hours");

  // Contrast: the pod is still running at the sweep -> billed to the confirmed termination (now).
  const g = fixture();
  const alive = await startRunning(g);
  g.advance(6 * 60 * 60_000);
  await g.services.bootSweep();
  assert.equal(g.mem.rows.get(alive.sessionId)!.secondsUsed, 6 * 3600 + 5); // the 5 s start poll + 6 h
});

test("review 7: the watcher's 'pod disappeared' closes the window at the previous sighting, and an operator Stop of a vanished pod does the same", async () => {
  const f = fixture();
  const running = await startRunning(f);
  f.advance(60_000);
  await tick1(f.services); // seen alive at startedAt + 5 s (start poll) + 60 s
  f.runpod.pods.delete("pod1");
  f.advance(30 * 60_000);
  assert.equal((await tick1(f.services)).action, "interrupted");
  assert.equal(f.mem.rows.get(running.sessionId)!.secondsUsed, 65);

  const g = fixture();
  const stopped = await startRunning(g);
  g.advance(120_000);
  await tick1(g.services);
  g.runpod.pods.delete("pod1");
  g.advance(10 * 60_000);
  const s = await g.services.stopSession({ sessionId: stopped.sessionId, reason: "stopped by operator" });
  assert.equal(s.status, "done");
  assert.equal(s.secondsUsed, 125); // 5 s start poll + 120 s
});

// -- review round 8 (2026-10-05) ------------------------------------------------------------------

// Slice 6: a session holds the volume by being active (shared), no longer by a lock row of its own; the assertions now
// observe the requirement itself (AC-P14-18: can a model pull take the volume?) instead of the row's owner.
test("review 8/9 (AC-P14-18 as a constraint): the session holds the volume from its `approved` write until it is terminal, on every exit path", async () => {
  // Running session: held; after the watcher stops it: released.
  const f = fixture();
  const running = await startRunning(f);
  assert.equal(await f.pullCanTakeVolume(), false);
  await f.services.stopSession({ sessionId: running.sessionId });
  assert.equal(await f.pullCanTakeVolume(), true);

  // A failed start (pod creation refused) releases it; a start whose pod lingers keeps it until the retry confirms.
  const g = fixture({ runpod: fakeRunpod({ createFails: true }) });
  const r1 = await g.services.requestSession(operatorRequest);
  await assert.rejects(g.services.approveAndStartSession({ sessionId: r1.sessionId }));
  assert.equal(await g.pullCanTakeVolume(), true);
  const h = fixture({ runpod: fakeRunpod({ terminateSticks: true }), comfy: fakeComfy({ never: true }) });
  const r2 = await h.services.requestSession(operatorRequest);
  await assert.rejects(h.services.approveAndStartSession({ sessionId: r2.sessionId }));
  assert.equal(h.mem.rows.get(r2.sessionId)!.status, "stopping");
  assert.equal(await h.pullCanTakeVolume(), false, "the pod may still write the volume");
  h.runpod.pods.delete("pod1");
  await tick1(h.services);
  assert.equal(await h.pullCanTakeVolume(), true);

  // The boot sweep's terminal write releases it too; a rejected pending request never held it.
  const i = fixture();
  const swept = await startRunning(i);
  await i.services.bootSweep();
  assert.equal(i.mem.rows.get(swept.sessionId)!.status, "interrupted");
  assert.equal(await i.pullCanTakeVolume(), true);
  const pending = await i.services.requestSession(operatorRequest);
  await i.services.rejectSession({ sessionId: pending.sessionId, reason: "no" });
  assert.equal(await i.pullCanTakeVolume(), true);
});

test("review 9: when createPod fails AND RunPod cannot be asked whether the pod exists, the session stays `approved` (slot and volume lock kept) and the watcher's later name search settles it -- never a freed slot on a guess", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  (f.runpod.client as unknown as { createPod: () => Promise<unknown> }).createPod = async () => {
    f.runpod.calls.push("createPod");
    throw new Error("RunPod API timed out");
  };
  let listPodsDown = true;
  const pod = { id: "pod9", name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING", costPerHr: 0.69, createdAt: null };
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => {
    if (listPodsDown) throw new Error("RunPod API returned HTTP 503");
    return [pod];
  };
  f.runpod.pods.set("pod9", { status: "RUNNING", costPerHr: 0.69 });
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed" && /could not confirm/.test(e.message));
  let row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "approved");
  assert.equal(row.podId, null);
  assert.match(row.error ?? "", /could not be asked whether the pod exists/);
  assert.equal(await f.pullCanTakeVolume(), false);
  assert.equal((await f.services.getLimits()).openSession?.sessionId, requested.sessionId, "the slot is NOT freed");
  // Later, RunPod answers: the watcher's abandoned-start path finds the pod by name and terminates it.
  listPodsDown = false;
  f.advance(10 * 60_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod9");
  assert.equal(f.runpod.pods.has("pod9"), false);
  assert.equal(await f.pullCanTakeVolume(), true);
});

// -- review round 11 (2026-10-05) -----------------------------------------------------------------

test("review 11: approve is refused when Settings → Media changed the GPU/datacenter/price since the request -- the estimate, the cap check and the record would describe a different pod than the one billed", async () => {
  const settings = { ...READY_SETTINGS };
  const runpod = fakeRunpod();
  const mem = memorySessionStore();
  let now = new Date("2026-10-05T10:00:00Z");
  const services = createMediaSessionServices({
    store: mem.store,
    base: {
      getSettings: async () => settings,
      getOverview: async () => ({ ready: true, missing: [], gatewayEnabled: true }),
      resolveRunpodClient: async () => runpod.client,
      sealSecret: async (text) => encryptSecret(text, KEY),
      openSecret: async (payload) => decryptSecret(payload, KEY),
    },
    createComfyClient: fakeComfy().factory,
    comfyUiProxyBaseUrl: (podId, port) => `https://${podId}-${port}.example.test`,
    generateId: () => "session-1",
    generateToken: () => "tok",
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    timeouts: { startMs: 60_000, pollMs: 5_000, stopMs: 20_000 },
    volumeLock: testLock().lock,
  });
  const requested = await services.requestSession(operatorRequest); // estimated at the 4090's $0.6/h
  settings.gpuTypeId = "NVIDIA H100 80GB HBM3";
  settings.gpuOnDemandPricePerHr = 4;
  await assert.rejects(services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid" && /changed since this request/.test(e.message));
  assert.equal(mem.rows.get(requested.sessionId)!.status, "pending");
  assert.ok(!runpod.calls.includes("createPod"));
  // Requested again under the new settings: approved with the H100's price on the record.
  await services.rejectSession({ sessionId: requested.sessionId, reason: "settings changed" });
  const again = await services.requestSession(operatorRequest);
  assert.equal(again.costPerHr, 4);
  const running = await services.approveAndStartSession({ sessionId: again.sessionId });
  assert.equal(running.status, "running");
});

test("review 11: a Stop whose terminate throws leaves the session `stopping` WITH the cause on the row (the watcher retries and the card can say why)", async () => {
  const f = fixture();
  const running = await startRunning(f);
  (f.runpod.client as unknown as { terminatePod: () => Promise<unknown> }).terminatePod = async () => {
    throw new Error("RunPod API returned HTTP 502");
  };
  await assert.rejects(f.services.stopSession({ sessionId: running.sessionId }), (e: unknown) => e instanceof Error && /HTTP 502/.test(e.message));
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "stopping");
  assert.match(row.error ?? "", /terminate failed: RunPod API returned HTTP 502; the watcher retries/);
});

// -- review round 12 (2026-10-05) -----------------------------------------------------------------

test("review 12: holdsVolumeLock is true only for a session past its `approved` write (a pending one never holds the volume, so a lock it left behind is stale)", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  assert.equal(await f.services.holdsVolumeLock(requested.sessionId), false);
  assert.equal(await f.services.holdsVolumeLock("nope"), false);
  const running = await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.equal(await f.services.holdsVolumeLock(running.sessionId), true);
  await f.services.stopSession({ sessionId: running.sessionId });
  assert.equal(await f.services.holdsVolumeLock(running.sessionId), false);
});

// -- review round 13 (2026-10-05) -----------------------------------------------------------------

test("review 13: every successful pod poll during the START wait marks the pod seen alive, so a pod that vanishes mid-start after a crash is billed to its last sighting, not 0 s (AC-P14-17)", async () => {
  const runpod = fakeRunpod({ runningAfterPolls: 3 });
  const f = fixture({ runpod, comfy: fakeComfy({ never: true }) });
  const requested = await f.services.requestSession(operatorRequest);
  // Snapshot the row as it is mid-start (5th pod poll): that is what a process dying right there would leave behind.
  const original = runpod.client.getPod.bind(runpod.client);
  let polls = 0;
  let midStart: StoredSessionRow | null = null;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    if (++polls === 5) midStart = { ...f.mem.rows.get(requested.sessionId)! };
    return original(id);
  };
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId })); // ComfyUI never answers: start fails
  assert.ok(midStart, "the snapshot was taken");
  const row = midStart as unknown as StoredSessionRow;
  assert.equal(row.status, "starting");
  assert.ok(row.lastSeenAliveAt && row.startedAt && row.lastSeenAliveAt.getTime() > row.startedAt.getTime(), "seen alive during the start polls");
  // Replay the crash: the row is as snapshotted, the pod was later killed by hand, the server reboots hours later.
  f.mem.rows.set(requested.sessionId, row);
  f.runpod.pods.delete("pod1");
  f.advance(3 * 60 * 60_000);
  await f.services.bootSweep();
  const swept = f.mem.rows.get(requested.sessionId)!;
  assert.equal(swept.status, "interrupted");
  assert.ok((swept.secondsUsed ?? 0) >= 15 && (swept.secondsUsed ?? 0) < 3600, `billed to the last sighting, got ${swept.secondsUsed}`);
});

test("review 14: an operator Stop on a row already `stopping` retries the terminate but keeps the row's own outcome and reason (an aborted start still ends `failed`)", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod, comfy: fakeComfy({ never: true }) });
  const requested = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }));
  const stopping = f.mem.rows.get(requested.sessionId)!;
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.stoppingOutcome, "failed");
  f.runpod.pods.delete("pod1");
  const stopped = await f.services.stopSession({ sessionId: requested.sessionId, reason: "stopped by operator" });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.stopReason ?? "", /start failed/);
});

test("review 14: an `approved` row whose approve request died has an operator Stop: the pod is searched by name and terminated now; while RunPod cannot be asked the slot is kept and the operator is told", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  const pod = { id: "pod9", name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING", costPerHr: 0.69, createdAt: null };
  f.runpod.pods.set("pod9", { status: "RUNNING", costPerHr: 0.69 });
  let runpodDown = true;
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => {
    if (runpodDown) throw new Error("RunPod API returned HTTP 503");
    return [pod];
  };
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "approved", approvedAt: f.getNow(), error: "pod creation failed (timeout) and RunPod could not be asked whether the pod exists" });
  await f.lock.tryAcquire(`session:${requested.sessionId}`, f.getNow());
  await assert.rejects(f.services.stopSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "runpod_api_unavailable");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "approved", "the slot is kept while the pod may exist");
  runpodDown = false;
  const stopped = await f.services.stopSession({ sessionId: requested.sessionId });
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.podId, "pod9");
  assert.equal(f.runpod.pods.has("pod9"), false);
  assert.equal(f.lock.current(), null);
  assert.equal((await f.services.getLimits()).openSession, null);
});

// -- review round 15 (2026-10-05) -----------------------------------------------------------------

test("review 15: a concurrent second approve of the same session that loses the `approved` transition must NOT release the volume lock the winner relies on", async () => {
  const f = fixture({ runpod: fakeRunpod({ runningAfterPolls: 3 }) });
  const requested = await f.services.requestSession(operatorRequest);
  // Make the first approve's `approved` write slow enough for a second approve to get past the preconditions.
  // Slice 6: the `approved` write is the store's guarded `approve`.
  const originalApprove = f.mem.store.approve.bind(f.mem.store);
  let firstApprovedWrite: Promise<unknown> | null = null;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  (f.mem.store as { approve: typeof originalApprove }).approve = async (id, set, max) => {
    if (firstApprovedWrite === null) {
      firstApprovedWrite = gate;
      await gate;
    }
    return originalApprove(id, set, max);
  };
  const first = f.services.approveAndStartSession({ sessionId: requested.sessionId });
  await new Promise((r) => setTimeout(r, 0));
  const second = f.services.approveAndStartSession({ sessionId: requested.sessionId }); // the retried POST
  await new Promise((r) => setTimeout(r, 0));
  release();
  const [a, b] = await Promise.allSettled([first, second]);
  const winner = a.status === "fulfilled" ? a : b;
  assert.equal(winner.status, "fulfilled");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "running");
  assert.equal(await f.pullCanTakeVolume(), false, "the running session still holds the volume");
});

test("review 15: Stop on an `approved` row is refused while its approve request may still be inside createPod (no error on the row, not yet abandoned by age)", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "approved", approvedAt: f.getNow() });
  await assert.rejects(f.services.stopSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state" && /still creating the pod/.test(e.message));
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "approved");
  // Abandoned by age: the manual override works (no pod of its name exists -> failed, slot freed).
  f.advance(10 * 60_000);
  const stopped = await f.services.stopSession({ sessionId: requested.sessionId });
  assert.equal(stopped.status, "failed");
});

test("review 15: a pod created after the session was stopped meanwhile, whose terminate cannot be confirmed, is written onto the row (podId, cost, how to terminate it) instead of being forgotten", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod });
  const requested = await f.services.requestSession(operatorRequest);
  const originalCreate = runpod.client.createPod.bind(runpod.client);
  (runpod.client as unknown as { createPod: (i: unknown) => Promise<unknown> }).createPod = async (input) => {
    const pod = await originalCreate(input as never);
    // The operator's Stop lands while createPod is in flight: the row is already abandoned by its error text.
    f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, error: "pod creation failed (timeout) and RunPod could not be asked" });
    await f.services.stopSession({ sessionId: requested.sessionId });
    return pod;
  };
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod1", "the late pod is recorded on the terminal row");
  assert.match(row.error ?? "", /terminate it by hand \(media pod-terminate pod1\)/);
});

// -- review round 17 (2026-10-05) -----------------------------------------------------------------

test("review 17: one transient RunPod failure during the readiness wait is tolerated (the pod is NOT terminated); a run of five is not", async () => {
  const runpod = fakeRunpod({ runningAfterPolls: 2 });
  const f = fixture({ runpod });
  const original = runpod.client.getPod.bind(runpod.client);
  let calls = 0;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    if (++calls === 2) throw new Error("RunPod API returned HTTP 502"); // one blip while the pod boots
    return original(id);
  };
  const running = await startRunning(f);
  assert.equal(running.status, "running");
  assert.ok(f.runpod.pods.has("pod1"), "the healthy pod was never terminated");

  const flaky = fakeRunpod();
  const g = fixture({ runpod: flaky });
  (flaky.client as unknown as { getPod: () => Promise<unknown> }).getPod = async () => {
    throw new Error("RunPod API returned HTTP 502");
  };
  const requested = await g.services.requestSession(operatorRequest);
  await assert.rejects(g.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed" && /HTTP 502/.test(e.message));
  // RunPod is still down, so the terminate cannot be CONFIRMED: the row stays `stopping` with the pod recorded (never
  // freed on a guess); once RunPod answers, the watcher finishes it `failed`.
  const row = g.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "stopping");
  assert.equal(row.podId, "pod1");
  (flaky.client as unknown as { getPod: (id: string) => Promise<unknown> }).getPod = async () => null;
  assert.equal((await tick1(g.services)).action, "stopped");
  assert.equal(g.mem.rows.get(requested.sessionId)!.status, "failed");
});

test("review 17: the boot sweep moves a running session to `stopping` BEFORE terminating, so nothing reads it as running while the terminate is confirmed", async () => {
  const f = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(f);
  const seen: string[] = [];
  const originalTerminate = f.runpod.client.terminatePod.bind(f.runpod.client);
  (f.runpod.client as unknown as { terminatePod: (id: string) => Promise<unknown> }).terminatePod = async (id: string) => {
    seen.push(f.mem.rows.get(running.sessionId)!.status);
    return originalTerminate(id);
  };
  await f.services.bootSweep();
  assert.deepEqual(seen, ["stopping"], "the row was `stopping` when RunPod was asked to terminate");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "stopping"); // unconfirmed -> stays stopping for the watcher
});

// -- review round 18 (2026-10-05) -----------------------------------------------------------------

test("review 18: a pod the watcher cannot GET is terminated through DELETE-then-confirm, never marked gone on the strength of one 404; a `done` stop of an already-gone pod carries no error", async () => {
  const f = fixture();
  await startRunning(f);
  // One transient 404 on a live pod: the watcher sends DELETE (idempotent) rather than freeing the slot on trust.
  const original = f.runpod.client.getPod.bind(f.runpod.client);
  let lies = 1;
  (f.runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => (lies-- > 0 ? null : original(id));
  const tick = await tick1(f.services);
  assert.equal(tick.action, "interrupted");
  assert.ok(f.runpod.calls.includes("terminate:pod1"), "DELETE was sent");
  assert.equal(f.runpod.pods.has("pod1"), false, "the live pod was really terminated, not left billing");

  // Operator Stop of a pod terminated by hand: `done`, the gone-note with the reason, no error text.
  const g = fixture();
  const stopped = await startRunning(g);
  g.runpod.pods.delete("pod1");
  const s = await g.services.stopSession({ sessionId: stopped.sessionId, reason: "stopped by operator" });
  assert.equal(s.status, "done");
  assert.equal(s.error, null);
  assert.match(s.stopReason ?? "", /stopped by operator \(pod was already gone/);
});

test("review 18: an abandoned `approved` row with an adopted orphan pod is `stopping` while its terminate is confirmed (a concurrent Stop resumes it, never a second reconcile), and an unparsable createdAt never makes the cost NaN", async () => {
  const f = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const requested = await f.services.requestSession(operatorRequest);
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "approved", approvedAt: f.getNow(), error: "pod creation failed and RunPod could not be asked" });
  f.runpod.pods.set("pod7", { status: "RUNNING", costPerHr: 0.69 });
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = async () => [{ id: "pod7", name: `ytm-media-${requested.sessionId.slice(0, 8)}`, status: "RUNNING", costPerHr: 0.69, createdAt: "not-a-date" }];
  const seen: string[] = [];
  const originalTerminate = f.runpod.client.terminatePod.bind(f.runpod.client);
  (f.runpod.client as unknown as { terminatePod: (id: string) => Promise<unknown> }).terminatePod = async (id: string) => {
    seen.push(f.mem.rows.get(requested.sessionId)!.status);
    return originalTerminate(id);
  };
  await f.services.stopSession({ sessionId: requested.sessionId }).catch(() => undefined);
  assert.deepEqual(seen, ["stopping"], "already `stopping` when RunPod was asked to terminate");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "stopping");
  assert.equal(row.podId, "pod7");
  assert.ok(row.startedAt && Number.isFinite(row.startedAt.getTime()), "a bad createdAt fell back to a real timestamp");
  f.runpod.pods.delete("pod7");
  await tick1(f.services);
  const done = f.mem.rows.get(requested.sessionId)!;
  assert.equal(done.status, "failed");
  assert.ok(Number.isFinite(done.usdCharged ?? NaN) && Number.isFinite(done.secondsUsed ?? NaN), "never NaN");
});

// -- review round 19 (2026-10-05) -----------------------------------------------------------------

test("review 19: a stop whose DELETE went through but whose confirm failed is billed, on the retry, to the moment of that DELETE -- not to the last sighting, and not as 'vanished on its own'", async () => {
  const f = fixture();
  const running = await startRunning(f);
  f.advance(60_000);
  await tick1(f.services); // seen alive at +65 s
  f.advance(10 * 60_000); // the stop is pressed 10 min later
  // DELETE succeeds, the confirm GET throws once (RunPod 502).
  const originalGet = f.runpod.client.getPod.bind(f.runpod.client);
  let failConfirm = true;
  (f.runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    if (failConfirm) {
      failConfirm = false;
      throw new Error("RunPod API returned HTTP 502");
    }
    return originalGet(id);
  };
  const deleteAt = f.getNow();
  await assert.rejects(f.services.stopSession({ sessionId: running.sessionId, reason: "stopped by operator" }));
  const stopping = f.mem.rows.get(running.sessionId)!;
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.terminateSentAt?.getTime(), deleteAt.getTime());
  f.advance(2 * 60_000); // the watcher retries two minutes later; the pod is gone (our DELETE did it)
  assert.equal((await tick1(f.services)).action, "stopped");
  const done = f.mem.rows.get(running.sessionId)!;
  assert.equal(done.status, "done");
  assert.equal(done.stoppedAt?.getTime(), deleteAt.getTime(), "billed to our DELETE");
  assert.equal(done.secondsUsed, 5 + 60 + 600);
  assert.equal(done.stopReason, "stopped by operator");
  assert.ok(!/already gone/.test(done.stopReason ?? ""), "no 'vanished on its own' note");
});

test("review 19: a pod created after the row was ended by another party, whose terminate IS confirmed, is still written onto that row with its billed seconds (never a pod on no row)", async () => {
  const f = fixture();
  const requested = await f.services.requestSession(operatorRequest);
  const originalCreate = f.runpod.client.createPod.bind(f.runpod.client);
  (f.runpod.client as unknown as { createPod: (i: unknown) => Promise<unknown> }).createPod = async (input) => {
    const pod = await originalCreate(input as never);
    f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, error: "pod creation failed and RunPod could not be asked" });
    await f.services.stopSession({ sessionId: requested.sessionId }); // ends it `failed` with no pod
    f.advance(30_000);
    return pod;
  };
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod1");
  assert.ok((row.secondsUsed ?? 0) >= 30, `billed ${row.secondsUsed} s`);
  assert.ok((row.usdCharged ?? 0) > 0);
  assert.match(row.error ?? "", /was terminated \(\d+ s billed\)/);
  assert.equal(f.runpod.pods.has("pod1"), false);
});

// -- review round 20 (2026-10-05) -----------------------------------------------------------------

test("review 20: the boot sweep's DELETE is recorded (terminateSentAt), so a retry that finds the pod gone bills the crash-to-reboot hours to our DELETE, not to the last pre-crash sighting", async () => {
  const f = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(f);
  f.advance(60_000);
  await tick1(f.services); // last sighting before the crash: +65 s
  f.advance(4 * 60 * 60_000); // the process was dead for four hours; the pod ran the whole time
  const rebootDelete = f.getNow();
  await f.services.bootSweep(); // DELETE goes through, confirm does not (the container lingers)
  const stopping = f.mem.rows.get(running.sessionId)!;
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.terminateSentAt?.getTime(), rebootDelete.getTime());
  f.runpod.pods.delete("pod1"); // gone by the next tick (our DELETE did it)
  f.advance(60_000);
  assert.equal((await tick1(f.services)).action, "stopped");
  const done = f.mem.rows.get(running.sessionId)!;
  assert.equal(done.status, "interrupted");
  assert.equal(done.secondsUsed, 5 + 60 + 4 * 3600, "billed to the reboot DELETE, four hours included");
});

test("review 20: a watcher stop that races an operator Stop never relabels the operator's deliberate `done` as `interrupted`", async () => {
  const f = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(f);
  // The operator's Stop lands first (its terminate is not confirmed -> `stopping`, done/'stopped by operator').
  await assert.rejects(f.services.stopSession({ sessionId: running.sessionId, reason: "stopped by operator" }).then(() => { throw new Error("expected stopping"); }), () => true).catch(() => undefined);
  const first = f.mem.rows.get(running.sessionId)!;
  assert.equal(first.status, "stopping");
  assert.equal(first.stoppingOutcome, "done");
  // The watcher, which had read the row as running a moment earlier, now finds the pod gone and runs ITS stop.
  f.runpod.pods.delete("pod1");
  await tick1(f.services);
  const done = f.mem.rows.get(running.sessionId)!;
  assert.equal(done.status, "done");
  assert.equal(done.stopReason, "stopped by operator");
  assert.equal(done.error, null);
});

// -- review round 21 (2026-10-05) -----------------------------------------------------------------

test("review 21: the boot sweep honors a DELETE an earlier attempt recorded (terminateSentAt) -- billed to it, no 'vanished on its own' note", async () => {
  const f = fixture();
  const running = await startRunning(f);
  f.advance(60_000);
  await tick1(f.services); // seen alive at +65 s
  f.advance(30_000);
  const deletedAt = f.getNow();
  // An earlier attempt's DELETE went through (recorded) and the process died before any terminal write; the pod is gone.
  f.mem.rows.set(running.sessionId, { ...f.mem.rows.get(running.sessionId)!, terminateSentAt: deletedAt });
  f.runpod.pods.delete("pod1");
  f.advance(3 * 60 * 60_000);
  await f.services.bootSweep();
  const row = f.mem.rows.get(running.sessionId)!;
  assert.equal(row.status, "interrupted");
  assert.equal(row.stoppedAt?.getTime(), deletedAt.getTime());
  assert.equal(row.secondsUsed, 5 + 60 + 30);
  assert.ok(!/already gone/.test(row.error ?? ""));
});

// -- slice 0 (2026-10-05): RUNNING is not "container up" -------------------------------------------

test("slice 0: a pod reported RUNNING whose container never starts (runtime null) is NOT waited on as ComfyUI -- the start times out saying the container never started, and the pod is terminated", async () => {
  const comfy = fakeComfy();
  const f = fixture({ runpod: fakeRunpod({ containerNeverStarts: true }), comfy });
  const requested = await f.services.requestSession(operatorRequest);
  const stages: string[] = [];
  await assert.rejects(
    f.services.approveAndStartSession({ sessionId: requested.sessionId, onStage: (s) => stages.push(s) }),
    (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed" && /container never started/.test(e.message)
  );
  assert.ok(stages.includes("Downloading the image and starting the container"));
  assert.ok(!stages.includes("Waiting for ComfyUI to answer"), "ComfyUI is never polled before the container is up");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "failed");
  assert.equal(f.runpod.pods.has("pod1"), false);
});

// Independent review before the dev merge (PHASE_14_PLAN.md §5.2: "the watcher stops every active session once the day's
// total reaches the cap"): a session still starting has a pod that bills, so the cap stops it too.
test("§5.2: once today's cap is reached the watcher stops a session that is still starting (its pod already bills)", async () => {
  const f = fixture({ settings: { maxUsdPerDay: 1, maxConcurrentSessions: 2 } });
  const requested = await f.services.requestSession(operatorRequest);
  f.runpod.pods.set("podS", { status: "RUNNING", costPerHr: 0.69 });
  const now = f.getNow();
  f.mem.rows.set(requested.sessionId, { ...f.mem.rows.get(requested.sessionId)!, status: "starting", podId: "podS", startedAt: now, approvedAt: now, costPerHr: 0.69 });
  // An earlier session today already spent $1.20 > the $1 cap.
  f.mem.rows.set("old", { ...f.mem.rows.get(requested.sessionId)!, id: "old", status: "done", podId: "podOld", startedAt: new Date(now.getTime() - 3 * 3600_000), stoppedAt: new Date(now.getTime() - 3600_000), usdCharged: 1.2, secondsUsed: 7200 });
  const ticks = await f.services.watchTick();
  const tick = ticks.find((t) => t.sessionId === requested.sessionId)!;
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /daily cap/);
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "done");
  assert.equal(f.runpod.pods.has("podS"), false);
});

// -- BL-135 (ADR 0023 amendment 2, owner 2026-10-06): the channel ends its own session; "release when done" ------------
// Expected from the owner's decision: an agent may only STOP spending -- withdraw its pending request or stop its own
// running pod -- never another channel's, never approve/start; with releaseWhenDone the watcher stops the pod one minute
// after the session's last job finished (counted from the last activity too), and never while a job is open.

test("BL-135: releaseSession stops this channel's running session (pod terminated, done) and withdraws a pending one", async () => {
  const f = fixture({ settings: { idleMinutes: 1000 } });
  const running = await startRunning(f, { maxMinutes: 60 });
  const released = await f.services.releaseSession({ sessionId: running.sessionId, channelId: "UC1" });
  assert.equal(released.status, "done");
  assert.match(released.stopReason ?? "", /released by the channel agent/);
  assert.equal(f.runpod.pods.has("pod1"), false);
  const pending = await f.services.requestSession({ ...operatorRequest, requestedBy: "agent" });
  const withdrawn = await f.services.releaseSession({ sessionId: pending.sessionId, channelId: "UC1" });
  assert.equal(withdrawn.status, "rejected");
  assert.match(withdrawn.stopReason ?? "", /withdrawn/);
});

test("BL-135: another channel's session is not found, a finished one is refused, and release never starts anything", async () => {
  const f = fixture({ settings: { idleMinutes: 1000 } });
  const running = await startRunning(f, { maxMinutes: 60 });
  await assert.rejects(f.services.releaseSession({ sessionId: running.sessionId, channelId: "UC_OTHER" }), (e: unknown) => isDomainError(e) && e.code === "media_session_not_found");
  assert.equal(f.mem.rows.get(running.sessionId)?.status, "running", "untouched");
  await f.services.releaseSession({ sessionId: running.sessionId, channelId: "UC1" });
  await assert.rejects(f.services.releaseSession({ sessionId: running.sessionId, channelId: "UC1" }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
});

test("BL-135: with releaseWhenDone the watcher stops the pod one minute after the last job finished -- never while a job is open, never without a job", async () => {
  let summary = { total: 0, open: 0, lastFinishedAt: null as Date | null };
  const f = fixture({ settings: { idleMinutes: 1000 }, jobSummary: async () => summary });
  const pending = await f.services.requestSession({ ...operatorRequest, maxMinutes: 600, releaseWhenDone: true });
  assert.equal(pending.releaseWhenDone, true);
  const { started } = await f.services.approveSession({ sessionId: pending.sessionId });
  await started;
  f.advance(5 * 60_000);
  assert.equal((await tick1(f.services)).action, "none", "no job yet: keep waiting for the first one");
  summary = { total: 1, open: 1, lastFinishedAt: null };
  f.advance(5 * 60_000);
  assert.equal((await tick1(f.services)).action, "none", "a job is running");
  summary = { total: 1, open: 0, lastFinishedAt: f.getNow() };
  f.advance(59_000);
  assert.equal((await tick1(f.services)).action, "none", "inside the minute");
  f.advance(2_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /all jobs done/);
  assert.equal(f.runpod.pods.has("pod1"), false);
});

test("BL-135: activity after the last finish (a new job being submitted) restarts the minute; a session without the flag is not released", async () => {
  const summary = { total: 2, open: 0, lastFinishedAt: new Date("2026-10-05T09:00:00Z") };
  const flagged = fixture({ settings: { idleMinutes: 1000 }, jobSummary: async () => summary });
  const p = await flagged.services.requestSession({ ...operatorRequest, maxMinutes: 600, releaseWhenDone: true });
  await (await flagged.services.approveSession({ sessionId: p.sessionId })).started;
  await flagged.services.touchActivity(p.sessionId);
  flagged.advance(30_000);
  assert.equal((await tick1(flagged.services)).action, "none");
  flagged.advance(31_000);
  assert.equal((await tick1(flagged.services)).action, "stopped");

  const plain = fixture({ settings: { idleMinutes: 1000 }, jobSummary: async () => summary });
  const q = await plain.services.requestSession({ ...operatorRequest, maxMinutes: 600 });
  await (await plain.services.approveSession({ sessionId: q.sessionId })).started;
  plain.advance(10 * 60_000);
  assert.equal((await tick1(plain.services)).action, "none");
});

// -- BL-133 (FACTORY_GPU_SESSIONS_PLAN.md §2.3/§2.4, AC-FG-04/05/06; owner answers 2026-10-06: retry every 30 s, wait 30 min) --
// Expected from the plan: the device GPU then its fallback list are tried in order; "could not be placed" moves on and is
// logged; nobody placeable = `waiting_capacity` with NO pod, retried by the watcher, failed with media_no_capacity after the
// wait; a waiting session holds its concurrency slot and can be stopped or released for free.

const FIVE = "NVIDIA GeForce RTX 5090";
const FOUR = "NVIDIA GeForce RTX 4090";

test("AC-FG-04: the first GPU 'could not be placed' -> the fallback is created; the row records what it got; the log has both attempts", async () => {
  const runpod = fakeRunpod({ capacity: (input) => input.gpu?.id === FOUR });
  const f = fixture({ runpod, settings: { gpuTypeId: FOUR, gpuFallbackIds: [FIVE] } });
  const requested = await f.services.requestSession(operatorRequest);
  const running = await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.equal(running.status, "running");
  assert.equal(running.gpuTypeId, FIVE);
  assert.deepEqual(f.capacityLog.map((a) => [a.gpuTypeId, a.result]), [[FOUR, "no_capacity"], [FIVE, "placed"]]);
  assert.deepEqual(runpod.calls.filter((c) => c.startsWith("createPod:")), [`createPod:${FOUR}`, `createPod:${FIVE}`]);
});

test("AC-FG-05: nobody placeable -> waiting_capacity with no pod; the watcher retries only when due; capacity returns -> running", async () => {
  let full = true;
  const runpod = fakeRunpod({ capacity: () => full });
  const f = fixture({ runpod, settings: { gpuTypeId: FOUR, gpuFallbackIds: [FIVE], capacityRetrySeconds: 30, capacityWaitMinutes: 30, idleMinutes: 1000 } });
  const requested = await f.services.requestSession(operatorRequest);
  const waiting = await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.equal(waiting.status, "waiting_capacity");
  assert.equal(waiting.podId, null);
  assert.equal(waiting.capacity?.attempts, 1);
  assert.equal(f.runpod.pods.size, 0, "no pod, nothing billed");
  f.advance(10_000);
  assert.equal((await tick1(f.services)).action, "none", "not due yet");
  f.advance(25_000);
  const retry = await tick1(f.services);
  assert.equal(retry.action, "retried_start");
  assert.equal(f.mem.rows.get(requested.sessionId)?.status, "waiting_capacity");
  assert.equal(f.mem.rows.get(requested.sessionId)?.capacityAttempts, 2);
  full = false;
  f.advance(31_000);
  await tick1(f.services);
  const row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "running");
  assert.equal(row.error, null);
});

test("AC-FG-05: after the capacity wait the session fails with media_no_capacity; a stop or a release while waiting ends it for free", async () => {
  const runpod = fakeRunpod({ capacity: () => true });
  const f = fixture({ runpod, settings: { gpuTypeId: FOUR, capacityRetrySeconds: 30, capacityWaitMinutes: 2 } });
  const a = await f.services.requestSession(operatorRequest);
  await f.services.approveAndStartSession({ sessionId: a.sessionId });
  f.advance(3 * 60_000);
  const tick = await tick1(f.services);
  assert.equal(tick.action, "stopped");
  const failed = f.mem.rows.get(a.sessionId)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /media_no_capacity/);
  assert.equal(failed.usdCharged, 0);

  const g = fixture({ runpod: fakeRunpod({ capacity: () => true }), settings: { gpuTypeId: FOUR } });
  const b = await g.services.requestSession(operatorRequest);
  await g.services.approveAndStartSession({ sessionId: b.sessionId });
  assert.equal((await g.services.stopSession({ sessionId: b.sessionId })).status, "done");
  const c = await g.services.requestSession(operatorRequest);
  await g.services.approveAndStartSession({ sessionId: c.sessionId });
  assert.equal((await g.services.releaseSession({ sessionId: c.sessionId, channelId: "UC1" })).status, "done");
});

test("BL-133: a waiting session holds its concurrency slot; the boot sweep leaves it to the watcher", async () => {
  const f = fixture({ runpod: fakeRunpod({ capacity: () => true }), settings: { gpuTypeId: FOUR, maxConcurrentSessions: 1 } });
  const a = await f.services.requestSession(operatorRequest);
  await f.services.approveAndStartSession({ sessionId: a.sessionId });
  const b = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.approveSession({ sessionId: b.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  await f.services.bootSweep();
  assert.equal(f.mem.rows.get(a.sessionId)?.status, "waiting_capacity");
});

test("AC-FG-04: a request's own GPU plan replaces the device list", async () => {
  const runpod = fakeRunpod();
  const f = fixture({ runpod, settings: { gpuTypeId: FOUR, gpuFallbackIds: [FIVE] } });
  const requested = await f.services.requestSession({ ...operatorRequest, gpu: { candidates: ["NVIDIA L40S"] } });
  assert.deepEqual(requested.gpuPlan, { candidates: ["NVIDIA L40S"], minVramGb: null, maxPricePerHr: null });
  await f.services.approveAndStartSession({ sessionId: requested.sessionId });
  assert.deepEqual(runpod.calls.filter((c) => c.startsWith("createPod:")), ["createPod:NVIDIA L40S"]);
});

// -- BL-133 G2 (plan §2.1/§2.2, AC-FG-01/02/03/09; owner defaults O2: $2 + 60 min per session, $5/day, $50/month, switch) ----

const FACTORY_ON = { factorySessionsEnabled: true, factoryMaxUsdPerSession: 2, factoryMaxMinutesPerSession: 60, factoryMaxUsdPerDay: 5, factoryMaxUsdPerMonth: 50 };
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("AC-FG-02: with the factory switch off a factory start only creates a pending request for the owner; no pod", async () => {
  const f = fixture();
  const result = await f.services.factoryStartSession({ channelId: "UC1" });
  assert.equal(result.approved, false);
  assert.match(result.heldBy ?? "", /switched off/);
  assert.equal(result.session.status, "pending");
  assert.equal(result.session.requestedBy, "factory");
  assert.equal(f.runpod.pods.size, 0);
  assert.deepEqual(f.events.map((e) => [e.actor, e.action]), [["factory", "session_held_for_owner"]]);
});

test("AC-FG-01: within every limit the factory's start is approved BY THE FACTORY and the pod starts with no owner click; caps default to the factory limits", async () => {
  const f = fixture({ settings: FACTORY_ON });
  const result = await f.services.factoryStartSession({ channelId: "UC1", releaseWhenDone: true });
  assert.equal(result.approved, true);
  await settle();
  const row = f.mem.rows.get(result.session.sessionId)!;
  assert.equal(row.approvedBy, "factory");
  assert.equal(row.requestedBy, "factory");
  assert.equal(row.maxMinutes, 60);
  assert.equal(row.maxUsd, 2);
  assert.equal(row.status, "running");
  assert.deepEqual(f.events.map((e) => [e.actor, e.action]), [["factory", "session_started"]]);
});

test("AC-FG-02: over the factory's per-session minutes or USD, its day or its month, the start waits for the owner and names the limit", async () => {
  const minutes = fixture({ settings: FACTORY_ON });
  assert.match((await minutes.services.factoryStartSession({ channelId: "UC1", maxMinutes: 90 })).heldBy ?? "", /90 min is over the factory's 60 min/);
  const usd = fixture({ settings: FACTORY_ON });
  assert.match((await usd.services.factoryStartSession({ channelId: "UC1", maxUsd: 3 })).heldBy ?? "", /\$3 is over the factory's \$2/);

  const day = fixture({ settings: FACTORY_ON });
  assert.equal((await day.services.factoryStartSession({ channelId: "UC1" })).approved, true);
  assert.equal((await day.services.factoryStartSession({ channelId: "UC1" })).approved, true);
  const third = await day.services.factoryStartSession({ channelId: "UC1" });
  assert.equal(third.approved, false, "2 + 2 reserved + 2 > 5");
  assert.match(third.heldBy ?? "", /factory's day would reach \$6/);
  assert.equal(third.session.status, "pending");

  const month = fixture({ settings: { ...FACTORY_ON, factoryMaxUsdPerMonth: 3 } });
  assert.equal((await month.services.factoryStartSession({ channelId: "UC1" })).approved, true);
  assert.match((await month.services.factoryStartSession({ channelId: "UC1" })).heldBy ?? "", /factory's month would reach \$4/);
});

test("AC-FG-02: a DEVICE limit (the owner's daily cap) also holds a factory start for the owner instead of failing it", async () => {
  const f = fixture({ settings: { ...FACTORY_ON, maxUsdPerDay: 0.1 } });
  const result = await f.services.factoryStartSession({ channelId: "UC1" });
  assert.equal(result.approved, false);
  assert.match(result.heldBy ?? "", /spend cap/);
  assert.equal(result.session.status, "pending");
  assert.equal(f.runpod.pods.size, 0);
});

test("AC-FG-03: the factory stops only sessions it started; the owner can still stop them; a held request is withdrawn", async () => {
  const f = fixture({ settings: FACTORY_ON });
  const mine = await f.services.factoryStartSession({ channelId: "UC1" });
  await settle();
  const owners = await f.services.requestSession(operatorRequest);
  await assert.rejects(f.services.factoryStopSession({ sessionId: owners.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_not_found");
  const stopped = await f.services.factoryStopSession({ sessionId: mine.session.sessionId });
  assert.equal(stopped.status, "done");
  assert.match(stopped.stopReason ?? "", /Factory Operator/);
  const held = await f.services.factoryStartSession({ channelId: "UC1", maxMinutes: 600 });
  assert.equal((await f.services.factoryStopSession({ sessionId: held.session.sessionId })).status, "rejected");
});
