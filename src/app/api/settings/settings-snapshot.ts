/**
 * Architecture audit 2026-10-01 (H2, docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md): the
 * Settings snapshot aggregates reads owned by ~10 different features. It used to be one
 * `Promise.all`, so any single failure (e.g. a Cloud grant that can no longer refresh) turned the
 * whole GET -- and the response of every successful POST -- into a 500, hiding the safety toggles
 * (Live writes, reads) with it (`AGENTS.md` §M). Each read is now isolated: a failed one becomes
 * `null` and is named in `unavailable`; every other field is returned normally.
 */
type Readers = {
  liveWritesEnabled: () => Promise<boolean>;
  mcpConnectionEnabled: () => Promise<boolean>;
  analyticsSync: () => Promise<{ localTime: string; timezone: string }>;
  dataApiReadsEnabled: () => Promise<boolean>;
  analyticsReadsEnabled: () => Promise<boolean>;
  gatewayTraffic: () => Promise<unknown>;
  cloudQuotaStatus: () => Promise<unknown>;
  operationsWorkspacePath: () => Promise<string | null>;
  marketIntelligenceDailyQuotaBudgetUnits: () => Promise<number | null>;
  operatorCliEnabled: () => Promise<boolean>;
  deviceAutoSyncEnabled: () => Promise<boolean>;
};

export async function buildSettingsSnapshot(readers: Readers) {
  const keys = Object.keys(readers) as Array<keyof Readers>;
  const results = await Promise.allSettled(keys.map((key) => readers[key]() as Promise<unknown>));
  const values: Partial<Record<keyof Readers, unknown>> = {};
  const unavailable: string[] = [];
  results.forEach((result, index) => {
    const key = keys[index];
    if (result.status === "fulfilled") {
      values[key] = result.value;
    } else {
      values[key] = null;
      unavailable.push(key);
      process.stderr.write(`[settings] "${key}" could not be read: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
    }
  });

  const analyticsSync = values.analyticsSync as { localTime: string; timezone: string } | null;
  return {
    liveWritesEnabled: values.liveWritesEnabled as boolean | null,
    mcpConnectionEnabled: values.mcpConnectionEnabled as boolean | null,
    analyticsSyncLocalTime: analyticsSync?.localTime ?? null,
    analyticsSyncTimezone: analyticsSync?.timezone ?? null,
    dataApiReadsEnabled: values.dataApiReadsEnabled as boolean | null,
    analyticsReadsEnabled: values.analyticsReadsEnabled as boolean | null,
    gatewayTraffic: values.gatewayTraffic ?? null,
    cloudQuotaStatus: values.cloudQuotaStatus ?? null,
    operationsWorkspacePath: values.operationsWorkspacePath as string | null,
    marketIntelligenceDailyQuotaBudgetUnits: values.marketIntelligenceDailyQuotaBudgetUnits as number | null,
    operatorCliEnabled: values.operatorCliEnabled as boolean | null,
    deviceAutoSyncEnabled: values.deviceAutoSyncEnabled as boolean | null,
    /** Names of the reads that failed this time (their fields are `null`). Empty when all succeeded. */
    unavailable,
  };
}
