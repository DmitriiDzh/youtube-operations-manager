import { VIDEO_RESERVATIONS_REPORT_VERSION, videoReservationsReportSchema, type VideoReservationsReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type VideoReservationsReportStore = PerDeviceReportStore;

export type VideoReservationsShareDeps = {
  store: VideoReservationsReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/**
 * BL-194: the video reservations report -- the shared per-device report mechanics (`../per-device-report`) with this family's
 * schema. A peer's report is never forgotten: a number it reserved stays taken while that computer is quiet, so a computer that
 * comes back after weeks never hands out the same number again (the BL-160 agent-tokens rule).
 */
export function createVideoReservationsShareCore(deps: VideoReservationsShareDeps) {
  return createPerDeviceReportCore<VideoReservationsReport>({
    schema: videoReservationsReportSchema,
    label: "video reservations report",
    currentVersion: VIDEO_RESERVATIONS_REPORT_VERSION,
    ...deps,
    forgetAfterMs: null,
  });
}

export type VideoReservationsShareCore = ReturnType<typeof createVideoReservationsShareCore>;
