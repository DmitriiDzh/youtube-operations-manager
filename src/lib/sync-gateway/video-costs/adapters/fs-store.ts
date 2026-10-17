import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { VideoCostsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsVideoCostsReportStore(dir: string): VideoCostsReportStore {
  return createFsPerDeviceReportStore(dir);
}
