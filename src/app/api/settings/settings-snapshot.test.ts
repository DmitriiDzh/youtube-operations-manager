import assert from "node:assert/strict";
import test from "node:test";
import { buildSettingsSnapshot } from "./settings-snapshot";

// docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md AC-H2-1: one failing feature read never hides
// the others -- in particular the safety toggles.

function readers(overrides: Partial<Parameters<typeof buildSettingsSnapshot>[0]> = {}) {
  return {
    liveWritesEnabled: async () => true,
    mcpConnectionEnabled: async () => false,
    analyticsSync: async () => ({ localTime: "12:05", timezone: "Europe/Helsinki" }),
    dataApiReadsEnabled: async () => true,
    analyticsReadsEnabled: async () => true,
    gatewayTraffic: async () => [{ category: "live_writes" }],
    cloudQuotaStatus: async () => ({ connected: true }),
    operationsWorkspacePath: async () => null,
    marketIntelligenceDailyQuotaBudgetUnits: async () => 500,
    operatorCliEnabled: async () => false,
    deviceAutoSyncEnabled: async () => true,
    ...overrides,
  };
}

test("all reads succeed: every field present, nothing unavailable", async () => {
  const snapshot = await buildSettingsSnapshot(readers());
  assert.equal(snapshot.liveWritesEnabled, true);
  assert.equal(snapshot.analyticsSyncLocalTime, "12:05");
  assert.equal(snapshot.marketIntelligenceDailyQuotaBudgetUnits, 500);
  assert.deepEqual(snapshot.unavailable, []);
});

test("AC-H2-1: a failing Cloud quota and a failing market-intelligence read do not hide the safety toggles", async () => {
  const snapshot = await buildSettingsSnapshot(
    readers({
      cloudQuotaStatus: async () => {
        throw new Error("Cloud connection token refresh failed");
      },
      marketIntelligenceDailyQuotaBudgetUnits: async () => {
        throw new Error("boom");
      },
    })
  );
  assert.equal(snapshot.liveWritesEnabled, true);
  assert.equal(snapshot.mcpConnectionEnabled, false);
  assert.equal(snapshot.dataApiReadsEnabled, true);
  assert.equal(snapshot.cloudQuotaStatus, null);
  assert.equal(snapshot.marketIntelligenceDailyQuotaBudgetUnits, null);
  assert.deepEqual(snapshot.unavailable.sort(), ["cloudQuotaStatus", "marketIntelligenceDailyQuotaBudgetUnits"]);
});

test("a failing analytics-sync read nulls both of its derived fields only", async () => {
  const snapshot = await buildSettingsSnapshot(
    readers({
      analyticsSync: async () => {
        throw new Error("x");
      },
    })
  );
  assert.equal(snapshot.analyticsSyncLocalTime, null);
  assert.equal(snapshot.analyticsSyncTimezone, null);
  assert.equal(snapshot.liveWritesEnabled, true);
});
