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
 * BL-091 -- registry/assignment CRUD plus the `assertAgentAllowedForCapability` enforcement
 * primitive (see its own doc comment below). Called from `src/mcp/server.ts`'s `registerTool`
 * wrapper and `src/cli/video-metadata.ts`'s zoned command handlers, and from
 * `src/app/api/agent-connections/**` for connection/zone management.
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
     * Fail-closed policy, keyed on ENABLED connections (a disabled one does not count -- disabling
     * every connection returns to today's single-agent, zero-behavior-change state, a deliberate
     * escape hatch):
     *
     * - **Zero enabled connections**: no-op.
     * - **One or more enabled connections**: a resolvable, enabled, registered
     *   `callerConnectionId` is required -- an unknown or missing one is rejected, never silently
     *   treated as "anyone" (a forgotten `AGENT_CONNECTION_ID` must never quietly bypass zoning).
     * - **A capability with an explicit zone assignment** always rejects every connection except
     *   the assigned one, regardless of how many connections are enabled.
     * - **A capability with NO explicit zone assignment** (no row, or `assignedConnectionId:
     *   null`) is open to the caller only while exactly one connection is enabled -- trivially
     *   unambiguous, since there is only one possible caller. **Once two or more connections are
     *   enabled, an unassigned capability is rejected for everyone**, not silently shared --
     *   the owner's own exclusivity requirement ("нельзя одну и ту же зону ответственности дать
     *   обоим") means an unassigned zone with multiple active agents is a configuration gap that
     *   must be fixed by an explicit assignment, not a default multi-agent grant.
     */
    async assertAgentAllowedForCapability(args: { capabilityId: string; callerConnectionId: string | null }): Promise<void> {
      const enabledConnections = (await deps.listConnections()).filter((c) => c.enabled);
      if (enabledConnections.length === 0) return;

      if (!args.callerConnectionId) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message:
            `Capability "${args.capabilityId}" requires a resolvable agent connection identity ` +
            "once at least one agent connection is enabled, but none was supplied.",
        });
      }

      const caller = enabledConnections.find((c) => c.id === args.callerConnectionId);
      if (!caller) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message: `Agent connection "${args.callerConnectionId}" is not a known, enabled connection.`,
        });
      }

      const zone = await deps.getZoneByCapabilityId(args.capabilityId);
      const assignedConnectionId = zone?.assignedConnectionId ?? null;

      if (assignedConnectionId === null) {
        if (enabledConnections.length >= 2) {
          throw new DomainError({
            code: "AGENT_ZONE_VIOLATION",
            message:
              `Capability "${args.capabilityId}" has no explicit zone assignment, and ` +
              `${enabledConnections.length} agent connections are enabled -- an unassigned ` +
              "capability cannot be shared once more than one connection is active. Assign it " +
              "to exactly one connection first.",
          });
        }
        return;
      }

      if (assignedConnectionId !== args.callerConnectionId) {
        throw new DomainError({
          code: "AGENT_ZONE_VIOLATION",
          message:
            `Capability "${args.capabilityId}" is assigned exclusively to agent connection ` +
            `"${assignedConnectionId}", not "${args.callerConnectionId}".`,
        });
      }
    },
  };
}

export type AgentConnectionsServices = ReturnType<typeof createAgentConnectionsServices>;
