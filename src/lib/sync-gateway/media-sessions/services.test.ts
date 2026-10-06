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
  const core = createMediaSessionsShareCore({ store, ownDeviceId: async () => "me" });
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

test("this device's own report, an invalid report, a report with extra fields and garbage are ignored", async () => {
  const { core, store } = fixture();
  assert.deepEqual(await core.mergeIncoming(bytes(report("me", "2026-10-06T10:05:00.000Z"))), { accepted: false });
  assert.deepEqual(await core.mergeIncoming(bytes({ ...report("x", "2026-10-06T10:05:00.000Z"), version: 2 })), { accepted: false });
  assert.deepEqual(await core.mergeIncoming(bytes({ ...report("x", "2026-10-06T10:05:00.000Z"), comfyUiProxyUrl: "https://secret" })), { accepted: false });
  const withSecretInSession = report("x", "2026-10-06T10:05:00.000Z");
  (withSecretInSession.sessions[0] as Record<string, unknown>).comfyUiProxyUrl = "https://pod-8189.proxy.runpod.net/?token=abc";
  assert.deepEqual(await core.mergeIncoming(bytes(withSecretInSession)), { accepted: false });
  assert.deepEqual(await core.mergeIncoming(bytes("{not json")), { accepted: false });
  assert.deepEqual(store.peers, {});
  assert.deepEqual(await core.listPeerReports(), []);
});

test("listPeerReports returns every peer, newest first", async () => {
  const { core } = fixture();
  await core.mergeIncoming(bytes(report("a", "2026-10-06T10:00:00.000Z")));
  await core.mergeIncoming(bytes(report("b", "2026-10-06T11:00:00.000Z")));
  assert.deepEqual((await core.listPeerReports()).map((r) => r.deviceId), ["b", "a"]);
});
