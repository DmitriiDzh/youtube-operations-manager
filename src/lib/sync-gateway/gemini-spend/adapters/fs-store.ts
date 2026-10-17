import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { GeminiSpendReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsGeminiSpendReportStore(dir: string): GeminiSpendReportStore {
  return createFsPerDeviceReportStore(dir);
}
