import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret, decryptSecret } from "@/lib/shared-crypto";
import type { ComfyUiClient, RunpodApiClient, RunpodPod } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSettings } from "./contracts";
import { createMediaSessionServices, type MediaSessionStore, type StoredSessionRow } from "./sessions";
import { createMemoryVolumeLockStore, createVolumeLock } from "./volume-lock";

/** A lock whose holder is "active" exactly while held (no cross-module staleness check in these unit tests). */
function testLock(opts: { heldBy?: string } = {}) {
  const store = createMemoryVolumeLockStore();
  if (opts.heldBy) void store.tryAcquire(opts.heldBy);
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

function memorySessionStore() {
  const rows = new Map<string, StoredSessionRow>();
  const store: MediaSessionStore = {
    async insert(row) {
      const open = [...rows.values()].find((r) => !TERMINAL.has(r.status));
      if (open) return null; // the UNIQUE(open_slot) index
      const stored = { ...row, createdAt: row.createdAt ?? new Date() };
      rows.set(row.id, stored);
      return stored;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getOpen() {
      return [...rows.values()].find((r) => !TERMINAL.has(r.status)) ?? null;
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

function fakeRunpod(opts: { createFails?: boolean; runningAfterPolls?: number; terminateSticks?: boolean } = {}) {
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
    env: {},
    createdAt: null,
    startedAt: null,
    raw: {},
  });
  const client = {
    async createPod(input: { env?: Record<string, string> }) {
      calls.push("createPod");
      if (opts.createFails) throw new Error("RunPod API returned HTTP 500: no capacity");
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
      if (opts.terminateSticks) return { terminated: true as const, alreadyGone: false };
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
} = {}) {
  const settings = { ...READY_SETTINGS, ...opts.settings };
  const runpod = opts.runpod ?? fakeRunpod();
  const comfy = opts.comfy ?? fakeComfy();
  const mem = memorySessionStore();
  let now = opts.now ?? new Date("2026-10-05T10:00:00Z");
  const missing = opts.ready === false ? ["network volume"] : [];
  let idCounter = 0;
  const lock = testLock();
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
  });
  return { services, mem, runpod, comfy, lock: lock.store, advance: (ms: number) => (now = new Date(now.getTime() + ms)), getNow: () => now };
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

test("AC-P14-05: a second request while one is pending/running is rejected with media_session_conflict and creates no row", async () => {
  const { services, mem } = fixture();
  await services.requestSession(operatorRequest);
  await assert.rejects(services.requestSession(operatorRequest), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  assert.equal(mem.rows.size, 1);
  const first = [...mem.rows.keys()][0];
  await services.approveAndStartSession({ sessionId: first, approvedByUserId: "u1" });
  await assert.rejects(services.requestSession(operatorRequest), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  assert.equal(mem.rows.size, 1);
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
  assert.equal((await f.services.watchTick()).action, "none");
  await f.services.touchActivity(running.sessionId);
  f.advance(9 * 60_000);
  assert.equal((await f.services.watchTick()).action, "none");
  f.advance(2 * 60_000);
  const tick = await f.services.watchTick();
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
  assert.equal((await byMinutes.services.watchTick()).action, "none");
  byMinutes.advance(2 * 60_000);
  const tickA = await byMinutes.services.watchTick();
  assert.equal(tickA.action, "stopped");
  assert.match(tickA.reason ?? "", /max minutes/);
  assert.equal(byMinutes.mem.rows.get(a.sessionId)!.status, "done");

  const byUsd = fixture({ settings: { idleMinutes: 1000 } });
  const b = await startRunning(byUsd, { maxMinutes: 600, maxUsd: 0.5 });
  // 0.69 $/h: $0.5 is reached after ~43.5 min.
  byUsd.advance(40 * 60_000);
  assert.equal((await byUsd.services.watchTick()).action, "none");
  byUsd.advance(5 * 60_000);
  const tickB = await byUsd.services.watchTick();
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
  const tickA = await exited.services.watchTick();
  assert.equal(tickA.action, "interrupted");
  assert.equal(exited.mem.rows.get(a.sessionId)!.status, "interrupted");
  assert.ok(exited.runpod.calls.includes("terminate:pod1"));
  assert.ok(!Object.keys(exited.runpod.client).includes("stopPod"));

  const gone = fixture();
  const b = await startRunning(gone);
  gone.runpod.pods.delete("pod1");
  const tickB = await gone.services.watchTick();
  assert.equal(tickB.action, "interrupted");
  assert.equal(gone.mem.rows.get(b.sessionId)!.status, "interrupted");
});

test("AC-P14-07: when the API cannot confirm termination the session stays stopping and the watcher retries", async () => {
  const runpod = fakeRunpod({ terminateSticks: true });
  const f = fixture({ runpod, settings: { idleMinutes: 1 } });
  const running = await startRunning(f, { maxMinutes: 600 });
  f.advance(2 * 60_000);
  const tick = await f.services.watchTick();
  assert.equal(tick.action, "retried_stop");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "stopping");
  assert.equal((await f.services.getLimits()).openSession?.status, "stopping");
  // Later the pod really goes away.
  f.runpod.pods.delete("pod1");
  const retry = await f.services.watchTick();
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
  assert.deepEqual(await f.services.stopForShutdown(), { stopped: running.sessionId });
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "done");
  assert.equal(f.mem.rows.get(running.sessionId)!.stopReason, "application shutdown");
  assert.deepEqual(await f.services.stopForShutdown(), { stopped: null });

  const sticky = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const s = await startRunning(sticky);
  assert.deepEqual(await sticky.services.stopForShutdown(), { stopped: null });
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
  assert.equal((await f.services.watchTick()).action, "none");
  f.advance(3 * 60_000); // ≈ $0.44 ≥ $0.42, still under maxMinutes (40)
  const tick = await f.services.watchTick();
  assert.equal(tick.action, "stopped");
  assert.match(tick.reason ?? "", /daily cap/);
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "done");
});

test("review: a RunPod error while polling the new pod never leaves it behind -- terminated and the session failed", async () => {
  const runpod = fakeRunpod();
  const original = runpod.client.getPod.bind(runpod.client);
  let polls = 0;
  (runpod.client as { getPod: (id: string) => Promise<unknown> }).getPod = async (id: string) => {
    polls++;
    if (polls === 1) {
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
  assert.equal((await f.services.watchTick()).action, "stopped");
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
  await assert.rejects(f.services.approveAndStartSession({ sessionId: requested.sessionId }), (e: unknown) => isDomainError(e) && e.code === "media_session_start_failed");
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
  assert.equal((await f.services.watchTick()).action, "stopped");
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
  assert.equal((await f.services.watchTick()).action, "none");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "starting");
  assert.ok(f.runpod.pods.has("pod1"));
  // Past it, the pod can only be an orphan.
  f.advance(20_000);
  const tick = await f.services.watchTick();
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
  assert.equal((await f.services.watchTick()).action, "none");
  assert.equal(f.mem.rows.get(requested.sessionId)!.status, "approved");
  // RunPod is back: the pod is found by name, terminated, the cost recorded.
  (f.runpod.client as { listPods: () => Promise<unknown[]> }).listPods = listPods;
  const tick = await f.services.watchTick();
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
  await f.services.watchTick();
  const aborted = f.mem.rows.get(requested.sessionId)!;
  assert.equal(aborted.status, "failed");
  assert.match(aborted.stopReason ?? "", /start failed/);
  assert.equal(aborted.readyAt, null);

  // Watcher stop (max USD) whose termination hung -> stopping; a restart's boot sweep keeps the reason and ends `done`.
  const g = fixture({ runpod: fakeRunpod({ terminateSticks: true }) });
  const running = await startRunning(g, { maxMinutes: 600, maxUsd: 0.05 });
  g.advance(10 * 60_000); // 600 s × 0.69 / 3600 = 0.115 ≥ 0.05
  assert.equal((await g.services.watchTick()).action, "retried_stop");
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
  assert.equal((await f.services.watchTick()).action, "retried_stop");
  assert.equal(f.mem.rows.get(running.sessionId)!.status, "stopping");
  f.runpod.pods.delete("pod1");
  assert.equal((await f.services.watchTick()).action, "stopped");
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
  assert.equal((await f.services.watchTick()).action, "none"); // the watcher sees the pod alive at T0+5s+5min
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
  await f.services.watchTick(); // seen alive at startedAt + 5 s (start poll) + 60 s
  f.runpod.pods.delete("pod1");
  f.advance(30 * 60_000);
  assert.equal((await f.services.watchTick()).action, "interrupted");
  assert.equal(f.mem.rows.get(running.sessionId)!.secondsUsed, 65);

  const g = fixture();
  const stopped = await startRunning(g);
  g.advance(120_000);
  await g.services.watchTick();
  g.runpod.pods.delete("pod1");
  g.advance(10 * 60_000);
  const s = await g.services.stopSession({ sessionId: stopped.sessionId, reason: "stopped by operator" });
  assert.equal(s.status, "done");
  assert.equal(s.secondsUsed, 125); // 5 s start poll + 120 s
});

// -- review round 8 (2026-10-05) ------------------------------------------------------------------

test("review 8/9 (AC-P14-18 as a constraint): the session holds the volume lock from its `approved` write until it is terminal, on every exit path", async () => {
  // Running session: held; after the watcher stops it: released.
  const f = fixture();
  const running = await startRunning(f);
  assert.equal(f.lock.current(), `session:${running.sessionId}`);
  await f.services.stopSession({ sessionId: running.sessionId });
  assert.equal(f.lock.current(), null);

  // A failed start (pod creation refused) releases it; a start whose pod lingers keeps it until the retry confirms.
  const g = fixture({ runpod: fakeRunpod({ createFails: true }) });
  const r1 = await g.services.requestSession(operatorRequest);
  await assert.rejects(g.services.approveAndStartSession({ sessionId: r1.sessionId }));
  assert.equal(g.lock.current(), null);
  const h = fixture({ runpod: fakeRunpod({ terminateSticks: true }), comfy: fakeComfy({ never: true }) });
  const r2 = await h.services.requestSession(operatorRequest);
  await assert.rejects(h.services.approveAndStartSession({ sessionId: r2.sessionId }));
  assert.equal(h.mem.rows.get(r2.sessionId)!.status, "stopping");
  assert.equal(h.lock.current(), `session:${r2.sessionId}`, "the pod may still write the volume");
  h.runpod.pods.delete("pod1");
  await h.services.watchTick();
  assert.equal(h.lock.current(), null);

  // The boot sweep's terminal write releases it too; a rejected pending request never held it.
  const i = fixture();
  const swept = await startRunning(i);
  await i.services.bootSweep();
  assert.equal(i.mem.rows.get(swept.sessionId)!.status, "interrupted");
  assert.equal(i.lock.current(), null);
  const pending = await i.services.requestSession(operatorRequest);
  await i.services.rejectSession({ sessionId: pending.sessionId, reason: "no" });
  assert.equal(i.lock.current(), null);
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
  assert.equal(f.lock.current(), `session:${requested.sessionId}`);
  assert.equal((await f.services.getLimits()).openSession?.sessionId, requested.sessionId, "the slot is NOT freed");
  // Later, RunPod answers: the watcher's abandoned-start path finds the pod by name and terminates it.
  listPodsDown = false;
  f.advance(10 * 60_000);
  const tick = await f.services.watchTick();
  assert.equal(tick.action, "stopped");
  row = f.mem.rows.get(requested.sessionId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.podId, "pod9");
  assert.equal(f.runpod.pods.has("pod9"), false);
  assert.equal(f.lock.current(), null);
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
