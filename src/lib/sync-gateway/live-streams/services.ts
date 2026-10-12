import { LIVE_STREAMS_REPORT_VERSION, liveStreamsReportSchema, type LiveStreamsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type LiveStreamsReportStore = PerDeviceReportStore;

/** BL-176: the live-streams report -- the shared per-device report mechanics with this family's strict schema. */
export function createLiveStreamsShareCore(deps: { store: LiveStreamsReportStore; ownDeviceId(): Promise<string>; clock?: { now(): Date } }) {
  return createPerDeviceReportCore<LiveStreamsReport>({ schema: liveStreamsReportSchema, label: "live streams report", currentVersion: LIVE_STREAMS_REPORT_VERSION, ...deps });
}

export type LiveStreamsShareCore = ReturnType<typeof createLiveStreamsShareCore>;
