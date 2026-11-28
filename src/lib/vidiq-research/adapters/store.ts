import { expireVidiqPendingRows, getVidiqSetting, hasVidiqPendingJob, insertVidiqLedgerRow, listVidiqLedgerRows, setVidiqSetting, updateVidiqLedgerRow } from "@/lib/db";
import type { VidiqStore } from "../contracts";

// BL-278: the module's database access, through `db.ts`'s helpers only (the ledger table and four device-local app_settings keys).
// The key lives in the shared device-secret store (`src/lib/device-secrets`, slot `vidiq`).
export function createVidiqStore(): VidiqStore {
  return {
    getSetting: (key) => getVidiqSetting(key),
    setSetting: (key, value) => setVidiqSetting(key, value),
    insertLedger: (row) => insertVidiqLedgerRow(row),
    updateLedger: (id, patch) => updateVidiqLedgerRow(id, patch),
    listLedger: (input) => listVidiqLedgerRows(input),
    hasPendingJob: (jobId) => hasVidiqPendingJob(jobId),
    expireStalePending: (before) => expireVidiqPendingRows(before),
  };
}
