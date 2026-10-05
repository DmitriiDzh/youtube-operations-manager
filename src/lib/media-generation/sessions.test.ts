import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret, decryptSecret } from "@/lib/shared-crypto";
import type { ComfyUiClient, RunpodApiClient, RunpodPod } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSettings } from "./contracts";
import { createMediaSessionServices, type MediaSessionStore, type StoredSessionRow } from "./sessions";

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
    async list(limit) {
      return [...rows.values()].slice(-limit).reverse();
    },
    async listStartedSince(since) {
      return [...rows.values()].filter((r) => r.startedAt && r.startedAt >= since);
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
  });
  return { services, mem, runpod, comfy, advance: (ms: number) => (now = new Date(now.getTime() + ms)), getNow: () => now };
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
