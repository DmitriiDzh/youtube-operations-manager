import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { ElevenlabsSpendReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsElevenlabsSpendReportStore(dir: string): ElevenlabsSpendReportStore {
  return createFsPerDeviceReportStore(dir);
}
