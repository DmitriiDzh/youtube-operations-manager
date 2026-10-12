import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { LiveStreamsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsLiveStreamsReportStore(dir: string): LiveStreamsReportStore {
  return createFsPerDeviceReportStore(dir);
}
