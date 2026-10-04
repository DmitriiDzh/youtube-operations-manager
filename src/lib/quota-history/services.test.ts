import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaHistoryServices, type QuotaHistoryDependencies } from "./services";
import type { QuotaCallLike } from "./grouping";

const NOW = new Date("2026-10-03T18:00:00Z"); // 11:00 PDT; the quota day began 2026-10-03T07:00:00Z
const sec = (iso: string) => Date.parse(iso) / 1000;
const call = (iso: string, over: Partial<QuotaCallLike> = {}): QuotaCallLike => ({
  occurredAt: sec(iso),
  method: "videos.update",
  units: 50,
  outcome: "ok",
  contextKind: "batch",
  contextId: "b1",
  contextLabel: "Batch b1",
  ...over,
});

function make(opts: { calls?: QuotaCallLike[]; peerCalls?: QuotaCallLike[]; cloud?: Awaited<ReturnType<QuotaHistoryDependencies["getCloudQuota"]>>; batchCounts?: Record<string, number> }) {
  const requested: Array<{ sinceSeconds: number }> = [];
  const services = createQuotaHistoryServices({
    async listCalls(args) {
      requested.push(args);
      return opts.calls ?? [];
    },
    async listPeerCalls() {
      return opts.peerCalls ?? [];
    },
    async countBatchRowsByStatus() {
      return opts.batchCounts ?? {};
    },
    async getCloudQuota() {
      return opts.cloud ?? { connected: false, status: null };
    },
    clock: { now: () => NOW },
  });
  return { services, requested };
}

test("a batch entry reports 'changed videos' from the batch's SUCCESS rows, not from the number of calls (retries differ)", async () => {
  const calls = [call("2026-10-03T15:00:00Z"), call("2026-10-03T15:00:01Z"), call("2026-10-03T15:00:02Z")]; // 3 update calls...
  const { services } = make({ calls, batchCounts: { SUCCESS: 2, FAILED: 1 } }); // ...but only 2 videos ended SUCCESS
  const result = await services.getQuotaHistory({ service: "data" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].calls, 3);
  assert.equal(result.entries[0].changedVideos, 2);
  assert.equal(result.entries[0].units, 150);
});

test("non-batch entries have no 'changed videos'", async () => {
  const { services } = make({ calls: [call("2026-10-03T15:00:00Z", { contextKind: "channel_sync", contextId: null, contextLabel: "Channel sync", method: "videos.list", units: 1 })] });
  assert.equal((await services.getQuotaHistory({ service: "data" })).entries[0].changedVideos, null);
});

test("Cloud connected: 'other' = Google's used minus what this device logged since the SAME reset boundary (calls before it are ignored)", async () => {
  const calls = [
    call("2026-10-02T20:00:00Z", { units: 500 }), // before the quota day began (07:00Z): not part of today's usage
    call("2026-10-03T08:00:00Z", { units: 300 }),
    call("2026-10-03T09:00:00Z", { units: 200 }),
  ];
  const cloud = { connected: true, status: { limit: 10000, usedLast24h: 1000, window: "since_reset" as const, resetsAt: "2026-10-04T07:00:00.000Z" } };
  const result = await make({ calls, cloud }).services.getQuotaHistory({ service: "data" });
  assert.equal(result.localUnits, 500);
  assert.equal(result.peerUnits, 0);
  assert.equal(result.otherUnits, 500);
  assert.deepEqual(result.cloud, { connected: true, limit: 10000, used: 1000, window: "since_reset", resetsAt: "2026-10-04T07:00:00.000Z" });
});

test("other is never negative when our log has more than Google reported (e.g. Monitoring lag)", async () => {
  const cloud = { connected: true, status: { limit: 10000, usedLast24h: 100, window: "since_reset" as const, resetsAt: null } };
  const result = await make({ calls: [call("2026-10-03T08:00:00Z", { units: 300 })], cloud }).services.getQuotaHistory({ service: "data" });
  assert.equal(result.otherUnits, 0);
});

test("rolling 24h window (Analytics): the local sum covers the last 24 hours, not the Pacific day", async () => {
  const calls = [call("2026-10-02T17:00:00Z", { units: 7 }), call("2026-10-02T19:00:00Z", { units: 5 })]; // 25 h ago and 23 h ago
  const cloud = { connected: true, status: { limit: 100000, usedLast24h: 9, window: "rolling_24h" as const, resetsAt: null } };
  const result = await make({ calls, cloud }).services.getQuotaHistory({ service: "analytics" });
  assert.equal(result.localUnits, 5);
  assert.equal(result.otherUnits, 4);
});

test("Cloud not connected: the figures are null (never 0), the history itself still shows", async () => {
  const result = await make({ calls: [call("2026-10-03T08:00:00Z")] }).services.getQuotaHistory({ service: "data" });
  assert.equal(result.cloud.connected, false);
  assert.equal(result.cloud.used, null);
  assert.equal(result.otherUnits, null);
  assert.equal(result.entries.length, 1);
});

test("the requested window is clamped to 1..45 days and defaults to 14", async () => {
  const a = make({});
  await a.services.getQuotaHistory({ service: "data" });
  assert.equal(a.requested[0].sinceSeconds, sec("2026-10-03T18:00:00Z") - 14 * 86400);
  const b = make({});
  await b.services.getQuotaHistory({ service: "data", days: 9999 });
  assert.equal(b.requested[0].sinceSeconds, sec("2026-10-03T18:00:00Z") - 45 * 86400);
  const c = make({});
  await c.services.getQuotaHistory({ service: "data", days: 0 });
  assert.equal(c.requested[0].sinceSeconds, sec("2026-10-03T18:00:00Z") - 1 * 86400);
});

test("shared log: another device's calls appear as their own entries, count as explained usage, and shrink 'not attributed'", async () => {
  const peerBatch: QuotaCallLike = { ...call("2026-10-03T09:00:00Z", { contextId: "batch-on-B", contextLabel: "Batch batch-on", units: 400, count: 8, unknownCount: 0 }), otherDevice: true };
  const cloud = { connected: true, status: { limit: 10000, usedLast24h: 1000, window: "since_reset" as const, resetsAt: null } };
  const result = await make({ calls: [call("2026-10-03T08:00:00Z", { units: 300 })], peerCalls: [peerBatch], cloud }).services.getQuotaHistory({ service: "data" });
  assert.equal(result.localUnits, 300);
  assert.equal(result.peerUnits, 400);
  assert.equal(result.otherUnits, 300, "1000 used by Google - 300 local - 400 from the other device");
  const other = result.entries.find((e) => e.contextId === "batch-on-B");
  assert.equal(other?.onOtherDevice, true);
  assert.equal(other?.calls, 8);
  assert.equal(result.entries.find((e) => e.contextId === "b1")?.onOtherDevice, false);
});

test("getLedgerUnits adds this device and the other devices inside the quota window: since the reset boundary 300+200 own plus 2650 peer = 3150, the 500 before it is ignored", async () => {
  const calls = [call("2026-10-02T20:00:00Z", { units: 500 }), call("2026-10-03T08:00:00Z", { units: 300 }), call("2026-10-03T09:00:00Z", { units: 200 })];
  const peerCalls = [call("2026-10-03T10:00:00Z", { units: 2650 })];
  const { services } = make({ calls, peerCalls });
  assert.equal(await services.getLedgerUnits({ service: "data", window: "since_reset" }), 3150);
});

test("getLedgerUnits with a rolling 24 h window starts at now minus 24 h (2026-10-02T18:00Z), so the 500 logged at 20:00Z counts: 500+300+200+2650 = 3650", async () => {
  const calls = [call("2026-10-02T17:00:00Z", { units: 999 }), call("2026-10-02T20:00:00Z", { units: 500 }), call("2026-10-03T08:00:00Z", { units: 300 }), call("2026-10-03T09:00:00Z", { units: 200 })];
  const peerCalls = [call("2026-10-03T10:00:00Z", { units: 2650 })];
  const { services } = make({ calls, peerCalls });
  assert.equal(await services.getLedgerUnits({ service: "data", window: "rolling_24h" }), 3650);
});

test("getLedgerUnits treats calls with unknown cost as 0 and returns 0 for an empty log", async () => {
  const { services } = make({ calls: [call("2026-10-03T08:00:00Z", { units: null })] });
  assert.equal(await services.getLedgerUnits({ service: "analytics", window: "since_reset" }), 0);
});
