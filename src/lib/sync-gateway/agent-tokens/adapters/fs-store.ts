import { createFsPerDeviceReportStore } from "../../per-device-report/fs-store";
import type { AgentTokensReportStore } from "../services";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsAgentTokensReportStore(dir: string): AgentTokensReportStore {
  return createFsPerDeviceReportStore(dir);
}
