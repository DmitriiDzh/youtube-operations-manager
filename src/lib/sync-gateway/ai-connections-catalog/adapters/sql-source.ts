import { listStoredAiConnections } from "@/lib/db";
import type { AiConnectionEntry } from "../contracts";

/** Read-only access to whatever `ai_connections` rows already existed in SQL BEFORE this module
 * owned writes -- used only to bootstrap the very first global document (mirrors
 * `editorial-profile/adapters/sql-source.ts`'s identical role, applied once for the whole
 * collection instead of per-row). */
export type SqlSourceAdapter = {
  listExistingConnections(): Promise<AiConnectionEntry[]>;
};

export function createSqlSourceAdapter(): SqlSourceAdapter {
  return {
    async listExistingConnections(): Promise<AiConnectionEntry[]> {
      const rows = await listStoredAiConnections();
      return rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        adapterType: row.adapterType,
        baseUrl: row.baseUrl,
        modelId: row.modelId,
        localInferenceMode: row.localInferenceMode,
        enabled: row.enabled,
        status: row.status,
        statusMessage: row.statusMessage,
        statusCheckedAt: row.statusCheckedAt ? row.statusCheckedAt.toISOString() : null,
        capabilitiesJson: row.capabilitiesJson,
        assignedTasksJson: row.assignedTasksJson,
        pricingJson: row.pricingJson,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
  };
}
