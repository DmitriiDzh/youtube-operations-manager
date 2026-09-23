import { randomUUID } from "node:crypto";
import {
  deleteStoredAiConnectionCredential,
  getStoredAiConnection,
  getStoredAiConnectionCredential,
  listStoredAiConnections,
  upsertStoredAiConnectionCredential,
  type StoredAiConnection,
} from "@/lib/db";
import { createAiConnectionsCatalogCoreForProduction, type AiConnectionEntry } from "@/lib/sync-gateway";

function toStoredAiConnection(entry: AiConnectionEntry): StoredAiConnection {
  return {
    ...entry,
    statusCheckedAt: entry.statusCheckedAt ? new Date(entry.statusCheckedAt) : null,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}

/**
 * Cutover, 2026-09-22 (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3, same
 * pattern as `ai-localization/adapters/profile-store.ts`'s cutover): writes now go through
 * `src/lib/sync-gateway/ai-connections-catalog/` (Automerge, one global document) instead of
 * directly to SQL. Reads stay pointed directly at the existing SQL functions -- the catalog
 * re-projects `ai_connections` after every successful write. The encrypted credential itself
 * (`ai_connection_credentials`) is untouched by this cutover -- device-local, never synced,
 * exactly as before (`AGENTS.md` §F).
 */
export function createAiConnectionStoreAdapter() {
  const catalog = createAiConnectionsCatalogCoreForProduction();

  return {
    async createConnection(input: {
      id: string;
      displayName: string;
      adapterType: string;
      baseUrl: string | null;
      modelId: string;
      localInferenceMode: boolean;
      enabled: boolean;
      capabilitiesJson: string;
      assignedTasksJson: string;
      pricingJson: string | null;
    }): Promise<StoredAiConnection> {
      const created = await catalog.createConnection(input);
      return toStoredAiConnection(created);
    },
    listConnections: listStoredAiConnections,
    getConnection: getStoredAiConnection,
    async updateConnection(
      connectionId: string,
      patch: Partial<{
        displayName: string;
        baseUrl: string | null;
        modelId: string;
        localInferenceMode: boolean;
        enabled: boolean;
        status: string;
        statusMessage: string | null;
        statusCheckedAt: Date | null;
        capabilitiesJson: string;
        assignedTasksJson: string;
        pricingJson: string | null;
      }>
    ): Promise<StoredAiConnection | null> {
      const updated = await catalog.updateConnection(connectionId, {
        ...patch,
        statusCheckedAt: patch.statusCheckedAt !== undefined ? (patch.statusCheckedAt ? patch.statusCheckedAt.toISOString() : null) : undefined,
      });
      return updated ? toStoredAiConnection(updated) : null;
    },
    async deleteConnection(connectionId: string): Promise<void> {
      await catalog.deleteConnection(connectionId);
    },
  };
}

export function createAiConnectionCredentialStoreAdapter() {
  return {
    upsertCredential: upsertStoredAiConnectionCredential,
    getCredential: getStoredAiConnectionCredential,
    deleteCredential: deleteStoredAiConnectionCredential,
  };
}

export function createIdGenerator() {
  return () => randomUUID();
}
