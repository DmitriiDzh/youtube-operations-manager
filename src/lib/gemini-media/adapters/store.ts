import {
  clearStoredGeminiCredentials,
  getGeminiMediaJob,
  getGeminiMediaJobByRequest,
  getGeminiMediaSettingsJson,
  getStoredGeminiCredentials,
  insertGeminiMediaJob,
  listGeminiMediaJobs,
  setGeminiMediaSettingsJson,
  setStoredGeminiCredentialsStatus,
  updateGeminiMediaJob,
  upsertStoredGeminiCredentials,
} from "@/lib/db";
import type { GeminiStore } from "../services";

// BL-174: the module's database access, through `db.ts`'s helpers only (one row of credentials, one settings value, the jobs).
export function createGeminiStore(): GeminiStore {
  return {
    getCredentials: () => getStoredGeminiCredentials(),
    upsertCredentials: (input) => upsertStoredGeminiCredentials(input),
    setCredentialsStatus: (checkedCiphertext, input) => setStoredGeminiCredentialsStatus(checkedCiphertext, input),
    clearCredentials: () => clearStoredGeminiCredentials(),
    getSettingsJson: () => getGeminiMediaSettingsJson(),
    setSettingsJson: (json) => setGeminiMediaSettingsJson(json),
    insertJob: (row) => insertGeminiMediaJob(row),
    getJob: (jobId) => getGeminiMediaJob(jobId),
    getJobByRequest: (createdBy, requestId) => getGeminiMediaJobByRequest(createdBy, requestId),
    listJobs: (filter) => listGeminiMediaJobs(filter),
    updateJob: (jobId, fromStatus, set) => updateGeminiMediaJob(jobId, fromStatus, set),
  };
}
