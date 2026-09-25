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
    getZoneByCapabilityId: store.getZoneByCapabilityId,
  });
}

export type AgentConnectionsCoreSubset = Pick<
  ReturnType<typeof createAgentConnectionsCore>,
  "assertAgentAllowedForCapability"
>;

export type { AgentConnection, AgentCapabilityZone } from "./contracts";
export type { AgentConnectionsServices } from "./services";
