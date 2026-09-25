import {
  insertAgentConnection,
  listAgentConnections,
  getAgentConnectionById,
  updateAgentConnectionEnabled,
  upsertAgentCapabilityZone,
  listAgentCapabilityZones,
  getAgentCapabilityZoneById,
} from "@/lib/db";

// Deliberately thin: only wraps the db.ts functions this module needs (AGENTS.md §D pattern,
// same shape as content-proposals/adapters/store.ts).
export function createAgentConnectionsStoreAdapter() {
  return {
    insertConnection: insertAgentConnection,
    listConnections: listAgentConnections,
    getConnectionById: getAgentConnectionById,
    updateConnectionEnabled: updateAgentConnectionEnabled,
    upsertZone: upsertAgentCapabilityZone,
    listZones: listAgentCapabilityZones,
    getZoneByCapabilityId: getAgentCapabilityZoneById,
  };
}

export type AgentConnectionsStoreAdapter = ReturnType<typeof createAgentConnectionsStoreAdapter>;
