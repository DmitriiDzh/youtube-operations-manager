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
  getZoneByCapabilityId: (capabilityId: string) => Promise<StoredAgentCapabilityZoneForService | null>;
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

    /**
     * Slice 2 -- the single enforcement primitive every zoned MCP tool/CLI command calls
     * immediately before its own domain logic runs (`docs/roadmap/plans/AGENT_ZONES_PLAN.md` §7,
     * mirrors the write/read gateway's own single-choke-point pattern, `AGENTS.md` §G).
     *
     * Fail-closed policy: while zero connections are registered, this is a no-op (identical to
     * today's single-agent behavior). Once one or more connections exist, a resolvable, enabled,
     * registered `callerConnectionId` is required for every zoned capability -- an unknown or
     * missing one is rejected, never silently treated as "anyone" (closes the exact gap an
     * advisor review flagged: a forgotten `AGENT_CONNECTION_ID` must never quietly bypass
     * zoning). A capability with no zone row, or a zone row whose `assignedConnectionId` is
     * `null`, is open to any registered+enabled connection. A capability assigned to a specific
     * connection rejects every other connection's calls.
     */
    async assertAgentAllowedForCapability(args: { capabilityId: string; callerConnectionId: string | null }): Promise<void> {
      const anyConnectionRegistered = (await deps.listConnections()).length > 0;
      if (!anyConnectionRegistered) return;

      if (!args.callerConnectionId) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message:
            `Capability "${args.capabilityId}" requires a resolvable agent connection identity ` +
            "once at least one agent connection is registered, but none was supplied.",
        });
      }

      const caller = await deps.getConnectionById(args.callerConnectionId);
      if (!caller || !caller.enabled) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message: `Agent connection "${args.callerConnectionId}" is not a known, enabled connection.`,
        });
      }

      const zone = await deps.getZoneByCapabilityId(args.capabilityId);
      if (zone && zone.assignedConnectionId !== null && zone.assignedConnectionId !== args.callerConnectionId) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message:
            `Capability "${args.capabilityId}" is assigned exclusively to agent connection ` +
            `"${zone.assignedConnectionId}", not "${args.callerConnectionId}".`,
        });
      }
    },
  };
}

export type AgentConnectionsServices = ReturnType<typeof createAgentConnectionsServices>;
