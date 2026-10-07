import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_SESSIONS_REPORT_FORMAT, type MediaSessionsReport } from "./contracts";
import { createMediaSessionsShareCore, type MediaSessionsReportStore } from "./services";

// BL-138 (plan docs/roadmap/plans/MEDIA_SESSIONS_CROSS_DEVICE_PLAN.md): each device publishes only its own report and keeps the
// latest report of every other device. Requirements: its own report never comes back as a peer; an older report never
// replaces a newer one; anything invalid is ignored; nothing to push yet is `not_found` (the runner's "nothing local").

function memoryStore(): MediaSessionsReportStore & { peers: Record<string, string>; local: () => string | null } {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    peers,
    local: () => local,
    readLocal: async () => local,
    writeLocal: async (json) => {
      local = json;
    },
    readPeers: async () => ({ ...peers }),
    writePeer: async (id, json) => {
      peers[id] = json;
    },
  };
}

const report = (deviceId: string, updatedAt: string, extra: Partial<MediaSessionsReport> = {}): MediaSessionsReport => ({
  format: MEDIA_SESSIONS_REPORT_FORMAT,
  version: 1,
  deviceId,
  hostname: `${deviceId}-host`,
  runpodAccountId: "acct1",
  updatedAt,
  spentTodayUsd: 0.5,
  sessions: [
    {
      sessionId: "s1",
      channelId: "UC1",
      status: "running",
      requestedBy: "operator",
      gpuTypeId: "NVIDIA GeForce RTX 4090",
      datacenterId: "EU-RO-1",
      podId: "pod1",
      costPerHr: 0.69,
      maxMinutes: 60,
      maxUsd: null,
      createdAt: "2026-10-06T10:00:00.000Z",
      approvedAt: "2026-10-06T10:00:05.000Z",
      startedAt: "2026-10-06T10:01:00.000Z",
      stoppedAt: null,
      secondsUsed: 600,
      usdCharged: 0.12,
      stopReason: null,
    },
  ],
  ...extra,
});
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

function fixture() {
  const store = memoryStore();
  const core = createMediaSessionsShareCore({ store, ownDeviceId: async () => "me", clock: { now: () => new Date("2026-10-06T12:00:00.000Z") } });
  return { store, core };
}

test("publish then export: the exported bytes are this device's report; before any publish there is nothing to push", async () => {
  const { core } = fixture();
  await assert.rejects(core.exportBytes(), (e: unknown) => (e as { code?: string }).code === "not_found");
  await core.publishLocalReport(report("me", "2026-10-06T10:05:00.000Z"));
  assert.equal(JSON.parse(new TextDecoder().decode(await core.exportBytes())).deviceId, "me");
});

test("a report for another device cannot be published as this device's own", async () => {
  const { core } = fixture();
  await assert.rejects(core.publishLocalReport(report("other", "2026-10-06T10:05:00.000Z")), (e: unknown) => (e as { code?: string }).code === "validation_failed");
});

test("a peer's report is kept; a newer one replaces it; an older one does not", async () => {
  const { core } = fixture();
  assert.deepEqual(await core.mergeIncoming(bytes(report("laptop", "2026-10-06T10:05:00.000Z"))), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes(report("laptop", "2026-10-06T10:06:00.000Z", { spentTodayUsd: 1 }))), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes(report("laptop", "2026-10-06T10:04:00.000Z", { spentTodayUsd: 9 }))), { accepted: false });
  const peers = await core.listPeerReports();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].spentTodayUsd, 1);
});

// Independent review: an unusable peer file is refused loudly (the runner lists it as skipped, with the reason, in the Merge
// tab) rather than silently, so a device on a newer app version does not just vanish from the view and the shared limits.
test("this device's own report is ignored quietly; an invalid, newer-version, extra-field, future-dated or garbage report is refused with a reason", async () => {
  const { core, store } = fixture();
  assert.deepEqual(await core.mergeIncoming(bytes(report("me", "2026-10-06T10:05:00.000Z"))), { accepted: false });
  const refused = async (value: unknown, reason: RegExp) =>
    assert.rejects(core.mergeIncoming(bytes(value)), (e: unknown) => (e as { code?: string }).code === "validation_failed" && reason.test((e as Error).message));
  // BL-148 changed the requirement: this build writes version 2 (CROSS_DEVICE_JOB_PROGRESS_PLAN.md), so "newer" is now 3.
  await refused({ ...report("x", "2026-10-06T10:05:00.000Z"), version: 3 }, /version 3 is newer/);
  await refused({ ...report("x", "2026-10-06T10:05:00.000Z"), comfyUiProxyUrl: "https://secret" }, /invalid/);
  const withSecretInSession = report("x", "2026-10-06T10:05:00.000Z");
  (withSecretInSession.sessions[0] as Record<string, unknown>).comfyUiProxyUrl = "https://pod-8189.proxy.runpod.net/?token=abc";
  await refused(withSecretInSession, /invalid/);
  await refused(report("x", "yesterday"), /invalid/);
  await refused(report("x", "2026-10-06T12:10:00.000Z"), /in the future/); // 10 min ahead of the 12:00 clock
  await refused({ ...report("x", "2026-10-06T10:05:00.000Z"), spentTodayUsd: 1e9 }, /invalid/);
  await refused("{not json", /unreadable/);
  assert.deepEqual(store.peers, {});
  assert.deepEqual(await core.listPeerReports(), []);
});

test("a peer silent for more than 7 days is no longer listed", async () => {
  const { core } = fixture();
  await core.mergeIncoming(bytes(report("retired", "2026-09-28T12:00:00.000Z")));
  await core.mergeIncoming(bytes(report("recent", "2026-09-30T12:00:00.000Z")));
  assert.deepEqual((await core.listPeerReports()).map((r) => r.deviceId), ["recent"]);
});

test("listPeerReports returns every peer, newest first", async () => {
  const { core } = fixture();
  await core.mergeIncoming(bytes(report("a", "2026-10-06T10:00:00.000Z")));
  await core.mergeIncoming(bytes(report("b", "2026-10-06T11:00:00.000Z")));
  assert.deepEqual((await core.listPeerReports()).map((r) => r.deviceId), ["b", "a"]);
});

// BL-148 (AC-XJ-03): version 2 reports carry an open session's jobs; a version 1 report of an older peer is still read.
test("a version 2 report with jobs and a version 1 report without are both accepted", async () => {
  const { core } = fixture();
  const v2 = report("new", "2026-10-06T10:05:00.000Z", { version: 2 });
  v2.sessions[0].jobs = {
    counts: { queued: 3, running: 1, done: 4, failed: 0, cancelled: 0 },
    capped: false,
    current: [
      {
        jobId: "j1",
        templateId: "ace-step-music",
        status: "generating",
        createdBy: "factory",
        submittedAt: "2026-10-06T10:02:00.000Z",
        planItemKey: null,
        progress: { state: "running", percent: 40, nodesTotal: 10, nodesDone: 4, nodesCached: 0, currentNodeType: "KSampler", step: { value: 20, max: 50 }, startedAt: "2026-10-06T10:02:01.000Z", updatedAt: "2026-10-06T10:04:59.000Z" },
      },
    ],
  };
  assert.deepEqual(await core.mergeIncoming(bytes(v2)), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes(report("old", "2026-10-06T10:05:00.000Z"))), { accepted: true });
  const peers = await core.listPeerReports();
  assert.equal(peers.find((r) => r.deviceId === "new")?.sessions[0].jobs?.current[0].progress?.percent, 40);
  assert.equal(peers.find((r) => r.deviceId === "old")?.sessions[0].jobs, undefined);
});
