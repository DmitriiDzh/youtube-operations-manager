import { createAgentConnectionsStoreAdapter } from "./adapters/store";
import { createAgentConnectionsServices } from "./services";

export function createAgentConnectionsCore() {
  const store = createAgentConnectionsStoreAdapter();
  return createAgentConnectionsServices({
    insertConnection: store.insertConnection,
    listConnections: store.listConnections,
    getConnectionById: store.getConnectionById,
    updateConnectionEnabled: store.updateConnectionEnabled,
    upsertZone: store.upsertZone,
    listZones: store.listZones,
  });
}

export type { AgentConnection, AgentCapabilityZone } from "./contracts";
export type { AgentConnectionsServices } from "./services";
