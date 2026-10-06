import assert from "node:assert/strict";
import test from "node:test";
import type { MediaSessionsReport } from "@/lib/sync-gateway";
import type { MediaSession } from "./contracts";
import { buildSessionsReport, deriveOtherDevices, toSharedSession } from "./cross-device";

// BL-138 (plan docs/roadmap/plans/MEDIA_SESSIONS_CROSS_DEVICE_PLAN.md, ADR 0028). Requirements: another device sees a session's
// state and cost but never its ComfyUI URL (it carries the proxy token) or RunPod error text; a peer's "running" session whose
// pod RunPod no longer has is shown as gone; a live session pod no device reports is shown; an old report is marked stale.

const NOW = new Date("2026-10-06T12:00:00.000Z");

function session(over: Partial<MediaSession>): MediaSession {
  return {
    sessionId: "s-open",
    channelId: "UC1",
    status: "running",
    requestedBy: "operator",
    approvedBy: "owner",
    gpuPlan: null,
    capacity: null,
    reason: null,
    maxMinutes: 60,
    maxUsd: null,
    estimateUsd: 0.69,
    fitsToday: true,
    costPerHr: 0.69,
    gpuTypeId: "NVIDIA GeForce RTX 4090",
    datacenterId: "EU-RO-1",
    podId: "pod-1",
    comfyUiProxyUrl: "https://pod-1-8189.proxy.runpod.net/?token=SECRET-TOKEN",
    createdAt: "2026-10-06T11:00:00.000Z",
    approvedAt: "2026-10-06T11:00:05.000Z",
    startedAt: "2026-10-06T11:01:00.000Z",
    readyAt: null,
    lastActivityAt: null,
    stoppedAt: null,
    secondsUsed: 3540,
    usdCharged: 0.68,
    stopReason: null,
    error: "RunPod said: internal detail",
    releaseWhenDone: false,
    ...over,
  };
}

test("the shared session carries no ComfyUI URL/token and no error text", () => {
  const shared = toSharedSession(session({}));
  const text = JSON.stringify(shared);
  assert.ok(!text.includes("SECRET-TOKEN") && !text.includes("proxy.runpod.net") && !text.includes("internal detail"));
  assert.equal(shared.podId, "pod-1");
  assert.equal(shared.usdCharged, 0.68);
});

test("the report keeps open sessions and those finished within 24 h, drops older finished ones", () => {
  const report = buildSessionsReport({
    deviceId: "me",
    hostname: "studio",
    runpodAccountId: "acct",
    now: NOW,
    spentTodayUsd: 1.25,
    sessions: [
      session({ sessionId: "open" }),
      session({ sessionId: "pending", status: "pending", podId: null, stoppedAt: null }),
      session({ sessionId: "recent", status: "done", stoppedAt: "2026-10-06T08:00:00.000Z" }),
      session({ sessionId: "old", status: "done", stoppedAt: "2026-10-05T11:59:00.000Z" }),
    ],
  });
  assert.deepEqual(report.sessions.map((s) => s.sessionId), ["open", "pending", "recent"]);
  assert.equal(report.updatedAt, NOW.toISOString());
  assert.equal(report.spentTodayUsd, 1.25);
  assert.ok(!JSON.stringify(report).includes("SECRET-TOKEN"));
});

const peer = (deviceId: string, updatedAt: string, sessions: MediaSessionsReport["sessions"], runpodAccountId: string | null = "acct"): MediaSessionsReport => ({
  format: "ytm-media-sessions",
  version: 1,
  deviceId,
  hostname: `${deviceId}-host`,
  runpodAccountId,
  updatedAt,
  spentTodayUsd: 2,
  sessions,
});

test("a peer's open session is pod_running when RunPod has its pod, pod_gone when not; pending is no_pod_yet; finished is ended", () => {
  const view = deriveOtherDevices({
    peers: [
      peer("laptop", "2026-10-06T11:59:00.000Z", [
        toSharedSession(session({ sessionId: "a", podId: "pod-a" })),
        toSharedSession(session({ sessionId: "b", podId: "pod-b" })),
        toSharedSession(session({ sessionId: "c", status: "pending", podId: null })),
        toSharedSession(session({ sessionId: "d", status: "done", podId: "pod-d" })),
      ]),
    ],
    ownAccountId: "acct",
    localPodIds: [],
    livePods: [{ id: "pod-a", name: "ytm-media-aaaaaaaa", costPerHr: 0.69, status: "RUNNING" }],
    now: NOW,
  });
  assert.deepEqual(view.devices[0].sessions.map((s) => [s.sessionId, s.live]), [
    ["a", "pod_running"],
    ["b", "pod_gone"],
    ["c", "no_pod_yet"],
    ["d", "ended"],
  ]);
  assert.equal(view.devices[0].sameAccount, true);
  assert.equal(view.devices[0].stale, false);
  assert.deepEqual(view.unknownPods, []);
});

test("a live session pod that neither this device nor any peer reports is listed; other pods and known ones are not", () => {
  const view = deriveOtherDevices({
    peers: [peer("laptop", "2026-10-06T11:59:00.000Z", [toSharedSession(session({ sessionId: "a", podId: "pod-peer" }))])],
    ownAccountId: "acct",
    localPodIds: ["pod-local"],
    livePods: [
      { id: "pod-local", name: "ytm-media-11111111", costPerHr: 0.69, status: "RUNNING" },
      { id: "pod-peer", name: "ytm-media-22222222", costPerHr: 0.69, status: "RUNNING" },
      { id: "pod-orphan", name: "ytm-media-33333333", costPerHr: 0.44, status: "RUNNING" },
      { id: "pod-pull", name: "ytm-pull-xyz", costPerHr: 0.06, status: "RUNNING" },
    ],
    now: NOW,
  });
  assert.deepEqual(view.unknownPods, [{ podId: "pod-orphan", name: "ytm-media-33333333", costPerHr: 0.44, status: "RUNNING" }]);
});

test("RunPod unreadable: the peer's word is kept, unknown pods are null and the error is passed on", () => {
  const view = deriveOtherDevices({
    peers: [peer("laptop", "2026-10-06T11:59:00.000Z", [toSharedSession(session({ sessionId: "a", podId: "pod-a" }))])],
    ownAccountId: "acct",
    localPodIds: [],
    livePods: null,
    podsError: "RunPod API timeout",
    now: NOW,
  });
  assert.equal(view.devices[0].sessions[0].live, "pod_running");
  assert.equal(view.unknownPods, null);
  assert.equal(view.podsError, "RunPod API timeout");
});

test("a report older than 5 minutes is stale; a different or unknown account id is not the same account", () => {
  const view = deriveOtherDevices({
    peers: [peer("old", "2026-10-06T11:54:59.000Z", [], "acct"), peer("other", "2026-10-06T11:59:00.000Z", [], "acct-2"), peer("unknown", "2026-10-06T11:59:00.000Z", [], null)],
    ownAccountId: "acct",
    localPodIds: [],
    livePods: [],
    now: NOW,
  });
  assert.deepEqual(view.devices.map((d) => [d.deviceId, d.stale, d.sameAccount]), [
    ["old", true, true],
    ["other", false, false],
    ["unknown", false, false],
  ]);
  const noOwnId = deriveOtherDevices({ peers: [peer("x", "2026-10-06T11:59:00.000Z", [], null)], ownAccountId: null, localPodIds: [], livePods: [], now: NOW });
  assert.equal(noOwnId.devices[0].sameAccount, false);
});
