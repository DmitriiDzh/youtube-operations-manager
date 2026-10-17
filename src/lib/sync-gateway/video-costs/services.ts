import { VIDEO_COSTS_REPORT_VERSION, videoCostsReportSchema, type VideoCostsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type VideoCostsReportStore = PerDeviceReportStore;

export type VideoCostsShareDeps = {
  store: VideoCostsReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/**
 * BL-194 stage 3: the video-costs report -- the shared per-device report mechanics with this family's schema. A peer's report is
 * never forgotten for being quiet (its runs stay counted for their videos); the reporting computer bounds its own report instead.
 */
export function createVideoCostsShareCore(deps: VideoCostsShareDeps) {
  return createPerDeviceReportCore<VideoCostsReport>({
    schema: videoCostsReportSchema,
    label: "video costs report",
    currentVersion: VIDEO_COSTS_REPORT_VERSION,
    ...deps,
    forgetAfterMs: null,
  });
}

export type VideoCostsShareCore = ReturnType<typeof createVideoCostsShareCore>;
