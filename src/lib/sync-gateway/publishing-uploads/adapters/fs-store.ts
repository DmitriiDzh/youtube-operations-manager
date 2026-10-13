import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { PublishingUploadsReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsPublishingUploadsReportStore(dir: string): PublishingUploadsReportStore {
  return createFsPerDeviceReportStore(dir);
}
