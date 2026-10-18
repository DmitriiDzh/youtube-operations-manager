import type { DeviceSecretStorePort, StoredDeviceSecretRow } from "./contracts";

/** An in-memory `device_secrets` (tests, and modules' own test harnesses): the same rules as the table -- revision grows on write. */
export function createMemoryDeviceSecretStore(): DeviceSecretStorePort & { rows: Map<string, StoredDeviceSecretRow>; migrated: Set<string> } {
  const rows = new Map<string, StoredDeviceSecretRow>();
  const migrated = new Set<string>();
  return {
    rows,
    migrated,
    async get(name) {
      const row = rows.get(name);
      return row ? { ...row, hints: { ...row.hints } } : null;
    },
    async upsert(row) {
      const previous = rows.get(row.name);
      rows.set(row.name, { ...row, revision: previous ? previous.revision + 1 : 1 });
    },
    async setStatus(name, expectedCiphertext, patch) {
      const row = rows.get(name);
      if (!row || row.ciphertext !== expectedCiphertext) return false;
      rows.set(name, { ...row, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}) });
      return true;
    },
    async delete(name) {
      rows.delete(name);
    },
    async isMigrated(name) {
      return migrated.has(name);
    },
    async markMigrated(name) {
      migrated.add(name);
    },
  };
}
