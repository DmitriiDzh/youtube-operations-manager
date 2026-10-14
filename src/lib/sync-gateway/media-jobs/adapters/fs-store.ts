import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { MediaJobsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsMediaJobsReportStore(dir: string): MediaJobsReportStore {
  return createFsPerDeviceReportStore(dir);
}
