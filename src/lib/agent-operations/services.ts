import {
  AGENT_API_VERSION,
  GRANTED_PERMISSIONS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
  type AgentCapabilityDescriptor,
  type AgentDataDomain,
  type SystemCapabilities,
} from "./contracts";
import { getSystemCapabilitiesInputSchema, parseWithSchema, systemCapabilitiesOutputSchema } from "./schemas";

/**
 * One entry per capability actually implemented and reachable today. Slice A ships only
 * `system.get_capabilities` itself -- every later slice (B: channel/video context, C: analytics,
 * D: asset catalog, E: localization drafts, F: bulk localization, G: content proposals) appends
 * its own entries here as it lands, never before. This is the literal, human-maintained inventory
 * `get_capabilities` reports -- not derived from `src/mcp/server.ts`'s tool registry, since not
 * every capability necessarily has (or needs) an MCP tool vs. an HTTP-only route.
 */
const AGENT_CAPABILITIES: AgentCapabilityDescriptor[] = [
  {
    id: "system.get_capabilities",
    domain: "system",
    permission: "READ",
    description:
      "Report this instance's product/agent-API version, implemented capabilities, data domains, the permission model, and current local schema version.",
  },
];

const AGENT_DATA_DOMAINS: AgentDataDomain[] = [];

type ServiceDependencies = {
  getProductVersion(): string;
  getSchemaVersion(): number;
};

export function createAgentOperationsServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §4's `get_system_capabilities()`. Pure with respect to this module's own state
     * (no I/O beyond the two injected lookups) -- always reflects exactly what is implemented in
     * THIS running instance, never a static aspirational list (owner spec §25: "Do not implement
     * empty fake tools merely to fill this list").
     */
    async getSystemCapabilities(input: unknown): Promise<SystemCapabilities> {
      parseWithSchema(getSystemCapabilitiesInputSchema, input, "get system capabilities input");

      const output: SystemCapabilities = {
        productVersion: deps.getProductVersion(),
        agentApiVersion: AGENT_API_VERSION,
        capabilities: AGENT_CAPABILITIES,
        dataDomains: AGENT_DATA_DOMAINS,
        actionClasses: PERMISSION_CLASSES,
        grantedPermissions: GRANTED_PERMISSIONS,
        plannedFutureCapabilities: PLANNED_FUTURE_CAPABILITIES,
        schemaVersions: {
          app: deps.getSchemaVersion(),
        },
      };

      return parseWithSchema(systemCapabilitiesOutputSchema, output, "get system capabilities output");
    },
  };
}

export type AgentOperationsServices = ReturnType<typeof createAgentOperationsServices>;
