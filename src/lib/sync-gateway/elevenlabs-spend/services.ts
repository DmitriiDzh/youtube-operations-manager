import { ELEVENLABS_SPEND_REPORT_VERSION, elevenlabsSpendReportSchema, type ElevenlabsSpendReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type ElevenlabsSpendReportStore = PerDeviceReportStore;

export type ElevenlabsSpendShareDeps = {
  store: ElevenlabsSpendReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/** Kept 32 days like Gemini's: a peer's month still counts against the shared monthly limit while that computer is off. */
export const ELEVENLABS_SPEND_FORGET_AFTER_MS = 32 * 24 * 60 * 60_000;

/** BL-236: the ElevenLabs spend report -- the shared per-device report mechanics with this family's schema. */
export function createElevenlabsSpendShareCore(deps: ElevenlabsSpendShareDeps) {
  return createPerDeviceReportCore<ElevenlabsSpendReport>({ schema: elevenlabsSpendReportSchema, label: "ElevenLabs spend report", currentVersion: ELEVENLABS_SPEND_REPORT_VERSION, forgetAfterMs: ELEVENLABS_SPEND_FORGET_AFTER_MS, ...deps });
}

export type ElevenlabsSpendShareCore = ReturnType<typeof createElevenlabsSpendShareCore>;
