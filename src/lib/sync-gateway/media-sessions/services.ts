import { MEDIA_SESSIONS_REPORT_VERSION, mediaSessionsReportSchema, type MediaSessionsReport } from "./contracts";
import { createPerDeviceReportCore, MAX_FUTURE_SKEW_MS, PEER_FORGET_AFTER_MS, type PerDeviceReportStore } from "../per-device-report";

/** Where this device keeps its own latest report and the peers' latest reports (JSON text, one entry per device). */
export type MediaSessionsReportStore = PerDeviceReportStore;

export type MediaSessionsShareDeps = {
  store: MediaSessionsReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

export { MAX_FUTURE_SKEW_MS, PEER_FORGET_AFTER_MS };

/** BL-138: the media sessions report -- the shared per-device report mechanics (`../per-device-report`) with this family's schema. */
export function createMediaSessionsShareCore(deps: MediaSessionsShareDeps) {
  return createPerDeviceReportCore<MediaSessionsReport>({ schema: mediaSessionsReportSchema, label: "media sessions report", currentVersion: MEDIA_SESSIONS_REPORT_VERSION, ...deps });
}

export type MediaSessionsShareCore = ReturnType<typeof createMediaSessionsShareCore>;
