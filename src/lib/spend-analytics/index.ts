import { listSpendGeminiFacts, listSpendJobFacts, listSpendSessionFacts } from "@/lib/db";
import { createVideoCostsServiceForProduction } from "@/lib/video-costs";
import type { SpendInputs } from "./contracts";

/** BL-219: every computer's runs (video-costs) and this computer's session / job facts, read once per request. Read-only. */
export async function readSpendInputs(): Promise<SpendInputs> {
  const [{ runs, computers }, sessions, jobs, gemini] = await Promise.all([
    createVideoCostsServiceForProduction().allRuns(),
    listSpendSessionFacts(),
    listSpendJobFacts(),
    listSpendGeminiFacts(),
  ]);
  return {
    runs,
    computers,
    facts: {
      sessions: new Map(sessions.map((row) => [row.id, row])),
      jobs: new Map(jobs.map((row) => [row.id, row])),
      gemini: new Map(gemini.map((row) => [row.jobId, row])),
    },
  };
}

export { buildHistory, buildSummary, dayKey, imageFileNames, lastDays, whoOf } from "./services";
export type { HistoryOptions } from "./services";
export * from "./contracts";
