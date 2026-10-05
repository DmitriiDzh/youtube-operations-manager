import { deleteStoredAiConnection, setStoredAiConnectionRow } from "@/lib/db";
import type { AiConnectionEntry } from "../contracts";

export type SqlProjectionAdapter = {
  upsertConnection(connection: AiConnectionEntry): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
};

export function createSqlProjectionAdapter(): SqlProjectionAdapter {
  return {
    async upsertConnection(connection: AiConnectionEntry): Promise<void> {
      await setStoredAiConnectionRow({
        id: connection.id,
        displayName: connection.displayName,
        adapterType: connection.adapterType,
        baseUrl: connection.baseUrl,
        modelId: connection.modelId,
        localInferenceMode: connection.localInferenceMode,
        enabled: connection.enabled,
        status: connection.status,
        statusMessage: connection.statusMessage,
        statusCheckedAt: connection.statusCheckedAt ? new Date(connection.statusCheckedAt) : null,
        capabilitiesJson: connection.capabilitiesJson,
        assignedTasksJson: connection.assignedTasksJson,
        pricingJson: connection.pricingJson,
        createdAt: new Date(connection.createdAt),
        updatedAt: new Date(connection.updatedAt),
      });
    },

    // Also removes the local device's own encrypted credential for this connection id (via
    // `deleteStoredAiConnection`, unchanged) -- correct even when the deletion arrived via a
    // merge from another device: nothing references that credential once its connection is gone.
    async deleteConnection(connectionId: string): Promise<void> {
      await deleteStoredAiConnection(connectionId);
    },
  };
}
