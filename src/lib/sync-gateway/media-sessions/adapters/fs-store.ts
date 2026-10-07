import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { MediaSessionsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsMediaSessionsReportStore(dir: string): MediaSessionsReportStore {
  return createFsPerDeviceReportStore(dir);
}
