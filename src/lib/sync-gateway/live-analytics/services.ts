import { LIVE_ANALYTICS_REPORT_VERSION, liveAnalyticsReportSchema, type LiveAnalyticsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type LiveAnalyticsReportStore = PerDeviceReportStore;

/** BL-222: the live-analytics report -- the shared per-device report mechanics with this family's strict schema. */
export function createLiveAnalyticsShareCore(deps: { store: LiveAnalyticsReportStore; ownDeviceId(): Promise<string>; clock?: { now(): Date } }) {
  return createPerDeviceReportCore<LiveAnalyticsReport>({ schema: liveAnalyticsReportSchema, label: "live analytics report", currentVersion: LIVE_ANALYTICS_REPORT_VERSION, ...deps });
}

export type LiveAnalyticsShareCore = ReturnType<typeof createLiveAnalyticsShareCore>;
