import {
  getGeminiMediaJob,
  getGeminiMediaJobByRequest,
  getGeminiMediaSettingsJson,
  insertGeminiMediaJob,
  listGeminiMediaJobs,
  setGeminiMediaSettingsJson,
  updateGeminiMediaJob,
} from "@/lib/db";
import type { GeminiStore } from "../services";

// BL-174: the module's database access, through `db.ts`'s helpers only (one settings value, the jobs). BL-199: the key lives in
// the shared device-secret store (`src/lib/device-secrets`), not here.
export function createGeminiStore(): GeminiStore {
  return {
    getSettingsJson: () => getGeminiMediaSettingsJson(),
    setSettingsJson: (json) => setGeminiMediaSettingsJson(json),
    insertJob: (row) => insertGeminiMediaJob(row),
    getJob: (jobId) => getGeminiMediaJob(jobId),
    getJobByRequest: (createdBy, requestId) => getGeminiMediaJobByRequest(createdBy, requestId),
    listJobs: (filter) => listGeminiMediaJobs(filter),
    updateJob: (jobId, fromStatus, set) => updateGeminiMediaJob(jobId, fromStatus, set),
  };
}
