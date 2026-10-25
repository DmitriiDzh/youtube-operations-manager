import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { LiveAnalyticsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsLiveAnalyticsReportStore(dir: string): LiveAnalyticsReportStore {
  return createFsPerDeviceReportStore(dir);
}
