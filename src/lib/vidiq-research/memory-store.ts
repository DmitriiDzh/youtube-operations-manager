import type { VidiqLedgerRow, VidiqSettingKey, VidiqStore } from "./contracts";

const RETENTION_MS = 90 * 24 * 60 * 60_000;

/** BL-278: an in-memory store with the table's rules (newest first, 90-day pruning on insert). Tests and harnesses. */
export function createMemoryVidiqStore(): VidiqStore & { settings: Map<VidiqSettingKey, string>; rows: VidiqLedgerRow[] } {
  const settings = new Map<VidiqSettingKey, string>();
  const rows: VidiqLedgerRow[] = [];
  let nextId = 1;
  return {
    settings,
    rows,
    async getSetting(key) {
      return settings.get(key) ?? null;
    },
    async setSetting(key, value) {
      if (value === null) settings.delete(key);
      else settings.set(key, value);
    },
    async insertLedger(row) {
      const id = nextId++;
      rows.push({ ...row, id });
      const cutoff = row.at.getTime() - RETENTION_MS;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].at.getTime() < cutoff) rows.splice(i, 1);
      return id;
    },
    async updateLedger(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
    async listLedger({ limit, since, now }) {
      const floor = (now ?? new Date()).getTime() - RETENTION_MS;
      const from = Math.max(floor, since?.getTime() ?? floor);
      return rows
        .filter((r) => r.at.getTime() >= from)
        .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async hasPendingJob(jobId) {
      return rows.some((r) => r.jobId === jobId && r.outcome === "job_pending");
    },
    async expireStalePending(before) {
      let changed = 0;
      for (const r of rows) {
        if (r.outcome === "pending" && r.at.getTime() < before.getTime()) {
          Object.assign(r, { outcome: "unknown", errorCode: "vidiq_outcome_unknown" });
          changed++;
        }
      }
      return changed;
    },
  };
}
