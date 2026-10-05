import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaGuardServices, type QuotaGuardDependencies } from "./services";

const NOW = new Date("2026-10-03T18:00:00Z");

function make(opts: {
  quota?: Awaited<ReturnType<QuotaGuardDependencies["getQuota"]>> | Error;
  localUnits?: number | Error;
  reserve?: number;
}) {
  const sinceRequested: number[] = [];
  const services = createQuotaGuardServices({
    async getQuota() {
      if (opts.quota instanceof Error) throw opts.quota;
      return opts.quota ?? { connected: false, status: null };
    },
    async sumLocalUnitsSince(_service, since) {
      sinceRequested.push(since);
      if (opts.localUnits instanceof Error) throw opts.localUnits;
      return opts.localUnits ?? 0;
    },
    async getReservePercent() {
      return opts.reserve ?? 20;
    },
    clock: { now: () => NOW },
  });
  return { services, sinceRequested };
}

const connected = (used: number, limit = 10000) => ({ connected: true, status: { limit, usedLast24h: used, resetsAt: "2026-10-04T07:00:00.000Z" } });

test("snapshot: Google's used plus this device's calls from the last 2 minutes (not yet in Google's figure) decide the remaining", async () => {
  const { services, sinceRequested } = make({ quota: connected(8000), localUnits: 600 });
  const snap = await services.getSnapshot();
  assert.deepEqual(snap, { known: true, limit: 10000, used: 8000, recentLocalUnits: 600, resetsAt: "2026-10-04T07:00:00.000Z" });
  assert.deepEqual(sinceRequested, [Math.floor(NOW.getTime() / 1000) - 120]);
  assert.equal((await services.checkWriteRun(25)).decision, "allow"); // 10000-8000-600-100 = 1300 = 25 x 52
  assert.equal((await services.checkWriteRun(26)).decision, "insufficient");
});

test("Cloud not connected, status null, or the lookup throwing: unknown, with the connected flag told truthfully", async () => {
  assert.deepEqual((await make({ quota: { connected: false, status: null } }).services.checkWriteRun(5)), { decision: "unknown", estimatedUnits: 260, cloudConnected: false });
  assert.deepEqual((await make({ quota: { connected: true, status: null } }).services.checkWriteRun(5)), { decision: "unknown", estimatedUnits: 260, cloudConnected: true });
  assert.equal((await make({ quota: new Error("monitoring down") }).services.checkWriteRun(5)).decision, "unknown");
});

test("a failing local log never blocks the check: Google's number alone decides", async () => {
  const { services } = make({ quota: connected(8000), localUnits: new Error("db busy") });
  const snap = await services.getSnapshot();
  assert.equal(snap.known && snap.recentLocalUnits, 0);
});

test("background reads honour the configured reserve", async () => {
  assert.equal(await make({ quota: connected(8000), reserve: 20 }).services.isBackgroundReadAllowed(), true); // 2000 left = 20%
  assert.equal(await make({ quota: connected(8100), reserve: 20 }).services.isBackgroundReadAllowed(), false);
  assert.equal(await make({ quota: connected(8100), reserve: 10 }).services.isBackgroundReadAllowed(), true); // 1900 left >= 10%
  assert.equal(await make({ quota: { connected: false, status: null }, reserve: 90 }).services.isBackgroundReadAllowed(), true, "unknown never blocks reads");
});

test("a background read is judged against ITS OWN pool: Analytics collection by the Analytics quota, not the Data API's", async () => {
  const asked: string[] = [];
  const services = createQuotaGuardServices({
    async getQuota(service) {
      asked.push(service);
      return service === "analytics" ? connected(1000, 100000) : connected(9990, 10000);
    },
    async sumLocalUnitsSince() {
      return 0;
    },
    async getReservePercent() {
      return 20;
    },
    clock: { now: () => NOW },
  });
  assert.equal(await services.isBackgroundReadAllowed("analytics"), true); // Analytics pool nearly untouched
  assert.equal(await services.isBackgroundReadAllowed("data"), false); // Data pool almost exhausted
  assert.deepEqual(asked, ["analytics", "data"]);
});
