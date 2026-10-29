import {
  getElevenlabsSpeechJob,
  getElevenlabsSpeechJobByRequest,
  getElevenlabsSpeechSettingsJson,
  insertElevenlabsSpeechJob,
  listElevenlabsSpeechJobs,
  setElevenlabsSpeechSettingsJson,
  updateElevenlabsSpeechJob,
} from "@/lib/db";
import type { ElevenlabsStore } from "../services";

// BL-236: the module's database access, through `db.ts`'s helpers only (one settings value, the jobs). The key lives in the shared
// device-secret store (`src/lib/device-secrets`, slot `elevenlabs`).
export function createElevenlabsStore(): ElevenlabsStore {
  return {
    getSettingsJson: () => getElevenlabsSpeechSettingsJson(),
    setSettingsJson: (json) => setElevenlabsSpeechSettingsJson(json),
    insertJob: (row) => insertElevenlabsSpeechJob(row),
    getJob: (jobId) => getElevenlabsSpeechJob(jobId),
    getJobByRequest: (createdBy, requestId) => getElevenlabsSpeechJobByRequest(createdBy, requestId),
    listJobs: (filter) => listElevenlabsSpeechJobs(filter),
    updateJob: (jobId, fromStatus, set) => updateElevenlabsSpeechJob(jobId, fromStatus, set),
  };
}
