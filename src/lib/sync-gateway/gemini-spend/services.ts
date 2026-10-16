import { GEMINI_SPEND_REPORT_VERSION, geminiSpendReportSchema, type GeminiSpendReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type GeminiSpendReportStore = PerDeviceReportStore;

export type GeminiSpendShareDeps = {
  store: GeminiSpendReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/** BL-193: the Gemini spend report -- the shared per-device report mechanics (`../per-device-report`) with this family's schema. */
export function createGeminiSpendShareCore(deps: GeminiSpendShareDeps) {
  return createPerDeviceReportCore<GeminiSpendReport>({ schema: geminiSpendReportSchema, label: "Gemini spend report", currentVersion: GEMINI_SPEND_REPORT_VERSION, ...deps });
}

export type GeminiSpendShareCore = ReturnType<typeof createGeminiSpendShareCore>;
