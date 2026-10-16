import { GEMINI_SPEND_REPORT_VERSION, geminiSpendReportSchema, type GeminiSpendReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type GeminiSpendReportStore = PerDeviceReportStore;

export type GeminiSpendShareDeps = {
  store: GeminiSpendReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/**
 * A peer's report is kept for 32 days, not the shared 7-day default: its month total still counts against the shared monthly
 * limit while that computer is switched off (review of BL-193). `accountWideSpend` itself drops reports from before this month.
 */
export const GEMINI_SPEND_FORGET_AFTER_MS = 32 * 24 * 60 * 60_000;

/** BL-193: the Gemini spend report -- the shared per-device report mechanics (`../per-device-report`) with this family's schema. */
export function createGeminiSpendShareCore(deps: GeminiSpendShareDeps) {
  return createPerDeviceReportCore<GeminiSpendReport>({ schema: geminiSpendReportSchema, label: "Gemini spend report", currentVersion: GEMINI_SPEND_REPORT_VERSION, forgetAfterMs: GEMINI_SPEND_FORGET_AFTER_MS, ...deps });
}

export type GeminiSpendShareCore = ReturnType<typeof createGeminiSpendShareCore>;
