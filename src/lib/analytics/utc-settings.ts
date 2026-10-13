// Owner, Telegram msgs 2725/2727 (2026-10-13): the analytics collection times are set in UTC. The services compute every
// boundary (staleness, the evening window, the weekly report, the "yesterday" of the auto-collection range) in the zone they are
// given; this hands them UTC and the UTC times, so the services stay zone-generic and the owner's own zone never moves a boundary.
export function utcCollectionSettingsStore(readTimes: () => Promise<{ dailyUtc: string; eveningUtc: string }>) {
  return {
    getAnalyticsSyncSettings: async () => ({ localTime: (await readTimes()).dailyUtc, timezone: "UTC" }),
    getAnalyticsEveningLocalTime: async () => (await readTimes()).eveningUtc,
  };
}
