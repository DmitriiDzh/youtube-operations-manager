import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { VideoReservationsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsVideoReservationsReportStore(dir: string): VideoReservationsReportStore {
  return createFsPerDeviceReportStore(dir);
}
