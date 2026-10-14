import { MEDIA_JOBS_REPORT_VERSION, mediaJobsReportSchema, type MediaJobsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type MediaJobsReportStore = PerDeviceReportStore;

/** BL-188: the media jobs report -- the shared per-device report mechanics with this family's strict schema. */
export function createMediaJobsShareCore(deps: { store: MediaJobsReportStore; ownDeviceId(): Promise<string>; clock?: { now(): Date } }) {
  return createPerDeviceReportCore<MediaJobsReport>({ schema: mediaJobsReportSchema, label: "media jobs report", currentVersion: MEDIA_JOBS_REPORT_VERSION, ...deps });
}

export type MediaJobsShareCore = ReturnType<typeof createMediaJobsShareCore>;
