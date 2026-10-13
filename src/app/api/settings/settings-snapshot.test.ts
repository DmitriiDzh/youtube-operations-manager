import assert from "node:assert/strict";
import test from "node:test";
import { buildSettingsSnapshot } from "./settings-snapshot";

// docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md AC-H2-1: one failing feature read never hides
// the others -- in particular the safety toggles.

function readers(overrides: Partial<Parameters<typeof buildSettingsSnapshot>[0]> = {}) {
  return {
    liveWritesEnabled: async () => true,
    mcpConnectionEnabled: async () => false,
    analyticsTimes: async () => ({ dailyUtc: "09:05", eveningUtc: "19:05" }),
    userTimezone: async () => "Europe/Helsinki",
    dataApiReadsEnabled: async () => true,
    analyticsReadsEnabled: async () => true,
    youtubeFeedReadsEnabled: async () => true,
    wikipediaReadsEnabled: async () => true,
    reportingReadsEnabled: async () => true,
    gatewayTraffic: async () => [{ category: "live_writes" }],
    cloudQuotaStatus: async () => ({ connected: true }),
    operationsWorkspacePath: async () => null,
    marketIntelligenceDailyQuotaBudgetUnits: async () => 500,
    operatorCliEnabled: async () => false,
    deviceAutoSyncEnabled: async () => true,
    quotaReservePercent: async () => 20,
    draftRetentionDays: async () => 7,
    writeLogRetentionDays: async () => 30,
    ...overrides,
  };
}

test("all reads succeed: every field present, nothing unavailable", async () => {
  const snapshot = await buildSettingsSnapshot(readers());
  assert.equal(snapshot.liveWritesEnabled, true);
  assert.equal(snapshot.analyticsSyncUtcTime, "09:05");
  assert.equal(snapshot.userTimezone, "Europe/Helsinki");
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

// Owner, Telegram msgs 2725/2727 (2026-10-13): both collection times are UTC values read together; the owner's zone is its own
// field (the quota reset time and the local times in parentheses use it), so either failing leaves the other.
test("a failing collection-times read nulls both UTC times only; the owner's zone stays", async () => {
  const snapshot = await buildSettingsSnapshot(
    readers({
      analyticsTimes: async () => {
        throw new Error("x");
      },
    })
  );
  assert.equal(snapshot.analyticsSyncUtcTime, null);
  assert.equal(snapshot.analyticsEveningUtcTime, null);
  assert.equal(snapshot.userTimezone, "Europe/Helsinki");
  assert.equal(snapshot.liveWritesEnabled, true);
  assert.deepEqual(snapshot.unavailable, ["analyticsTimes"]);
});

test("a failing zone read nulls only the zone", async () => {
  const snapshot = await buildSettingsSnapshot(
    readers({
      userTimezone: async () => {
        throw new Error("x");
      },
    })
  );
  assert.equal(snapshot.userTimezone, null);
  assert.equal(snapshot.analyticsSyncUtcTime, "09:05");
  assert.deepEqual(snapshot.unavailable, ["userTimezone"]);
});

// BL-181 (FO-REQ-0020 §2.3): the evening re-collect boundary is returned as stored; "" means off.
test("BL-181: the evening boundary is returned as stored ('' = off)", async () => {
  assert.equal((await buildSettingsSnapshot(readers())).analyticsEveningUtcTime, "19:05");
  const off = await buildSettingsSnapshot(readers({ analyticsTimes: async () => ({ dailyUtc: "09:05", eveningUtc: "" }) }));
  assert.equal(off.analyticsEveningUtcTime, "");
  assert.equal(off.analyticsSyncUtcTime, "09:05");
});
