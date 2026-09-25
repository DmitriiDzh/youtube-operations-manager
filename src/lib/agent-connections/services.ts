import { DomainError, type AgentConnection, type AgentCapabilityZone } from "./contracts";
import {
  assignAgentCapabilityZoneInputSchema,
  parseWithSchema,
  registerAgentConnectionInputSchema,
  setAgentConnectionEnabledInputSchema,
} from "./schemas";

type StoredAgentConnectionForService = {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: Date;
};

type StoredAgentCapabilityZoneForService = {
  capabilityId: string;
  assignedConnectionId: string | null;
};

export type ServiceDependencies = {
  insertConnection: (input: { id: string; label: string; enabled: boolean }) => Promise<void>;
  listConnections: () => Promise<StoredAgentConnectionForService[]>;
  getConnectionById: (id: string) => Promise<StoredAgentConnectionForService | null>;
  updateConnectionEnabled: (id: string, enabled: boolean) => Promise<void>;
  upsertZone: (input: { capabilityId: string; assignedConnectionId: string | null }) => Promise<void>;
  listZones: () => Promise<StoredAgentCapabilityZoneForService[]>;
};

function toAgentConnection(row: StoredAgentConnectionForService): AgentConnection {
  return {
    id: row.id,
    label: row.label,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAgentCapabilityZone(row: StoredAgentCapabilityZoneForService): AgentCapabilityZone {
  return { capabilityId: row.capabilityId, assignedConnectionId: row.assignedConnectionId };
}

/**
 * BL-091 slice 1 -- registry/assignment CRUD only. Nothing here is called by any MCP tool, CLI
 * command, or API route yet; enforcement (slice 2) is a separate, not-yet-built consumer of
 * `listZones`/`getConnectionById`, pending the open scope question in
 * `docs/roadmap/plans/AGENT_ZONES_PLAN.md` §9.
 */
export function createAgentConnectionsServices(deps: ServiceDependencies) {
  return {
    async registerConnection(input: unknown): Promise<AgentConnection> {
      const parsed = parseWithSchema(registerAgentConnectionInputSchema, input, "register agent connection input");

      const existing = await deps.getConnectionById(parsed.id);
      if (existing) {
        throw new DomainError({
          code: "AGENT_CONNECTION_ID_CONFLICT",
          message: `An agent connection with id "${parsed.id}" already exists.`,
        });
      }

      await deps.insertConnection({ id: parsed.id, label: parsed.label, enabled: parsed.enabled });
      const created = await deps.getConnectionById(parsed.id);
      // Cannot be null -- insertConnection just succeeded for this exact id, with no concurrent
      // deleter existing anywhere in this codebase (no delete operation is defined for slice 1).
      return toAgentConnection(created!);
    },

    async listConnections(): Promise<AgentConnection[]> {
      const rows = await deps.listConnections();
      return rows.map(toAgentConnection);
    },

    async setConnectionEnabled(input: unknown): Promise<AgentConnection> {
      const parsed = parseWithSchema(setAgentConnectionEnabledInputSchema, input, "set agent connection enabled input");

      const existing = await deps.getConnectionById(parsed.id);
      if (!existing) {
        throw new DomainError({
          code: "AGENT_CONNECTION_NOT_AVAILABLE",
          message: `No agent connection with id "${parsed.id}" exists.`,
        });
      }

      await deps.updateConnectionEnabled(parsed.id, parsed.enabled);
      const updated = await deps.getConnectionById(parsed.id);
      return toAgentConnection(updated!);
    },

    async assignCapabilityZone(input: unknown): Promise<AgentCapabilityZone> {
      const parsed = parseWithSchema(assignAgentCapabilityZoneInputSchema, input, "assign agent capability zone input");

      if (parsed.assignedConnectionId !== null) {
        const existing = await deps.getConnectionById(parsed.assignedConnectionId);
        if (!existing) {
          throw new DomainError({
            code: "AGENT_CONNECTION_NOT_AVAILABLE",
            message: `No agent connection with id "${parsed.assignedConnectionId}" exists.`,
          });
        }
      }

      await deps.upsertZone({ capabilityId: parsed.capabilityId, assignedConnectionId: parsed.assignedConnectionId });
      return { capabilityId: parsed.capabilityId, assignedConnectionId: parsed.assignedConnectionId };
    },

    async listCapabilityZones(): Promise<AgentCapabilityZone[]> {
      const rows = await deps.listZones();
      return rows.map(toAgentCapabilityZone);
    },
  };
}

export type AgentConnectionsServices = ReturnType<typeof createAgentConnectionsServices>;
