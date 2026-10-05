/**
 * The Factory Operator's MCP server (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.4, slice F3).
 *
 * A server of its own, NOT a subset of `createMcpServer` (`src/mcp/server.ts`): it registers exactly the
 * tools in `FACTORY_TOOL_NAMES`, read-only, and everything it can reach arrives through the injected
 * `FactoryToolDeps` -- this file imports no domain module, no YouTube gateway, no database and no
 * channel-scope state. `src/mcp/factory-server.test.ts` fails the suite if the registered tool names
 * differ from that list, if a channel tool name is registered here, if a factory tool name is
 * classified for channel sessions, or if this file imports anything outside its allowlist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";

/** The factory API's own version (independent of the channel agents' `AGENT_API_VERSION`). */
export const FACTORY_API_VERSION = "1.0.0";

/** The complete, explicit allowlist of tools. A new name must be added here deliberately, with its test. */
export const FACTORY_TOOL_NAMES = [
  "factory_get_capabilities",
  "factory_list_logical_paths",
  "factory_get_logical_path",
  "factory_list_channels",
] as const;

export type FactoryChannelEntry = {
  channelId: string;
  title: string;
  /** This device's production-workspace path for the channel, or `configured:false`. */
  workspace: { configured: false } | { configured: true; path: string };
};

/** Everything the factory tools can reach. Wired in `src/app/api/mcp/factory/route.ts`. */
export type FactoryToolDeps = {
  readLogicalPath(input: unknown): Promise<{ name: string; path: string }>;
  listLogicalPaths(): Promise<
    Array<{ name: string; description: string; configured: false } | { name: string; description: string; configured: true; path: string }>
  >;
  listChannels(): Promise<FactoryChannelEntry[]>;
  /** Counts a real tool invocation for the Settings traffic stats (`mcp_tool_calls`). */
  recordOutcome(outcome: "allowed" | "blocked"): Promise<void>;
};

export type FactoryServerOptions = {
  /** The verified session of THIS request. Absent means "no valid token": ZERO tools are registered. */
  session?: { tokenId: string; reverify(): Promise<void> } | null;
  connectionEnabled?: boolean;
};

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function successResult(payload: Record<string, unknown>): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function errorResult(error: unknown): ToolResponse {
  const shape =
    error instanceof DomainError
      ? { code: error.code, message: error.message, details: error.details }
      : { code: "internal_error", message: "internal error" };
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: shape }) }], isError: true };
}

const emptyInput = z.object({}).strict();
const getLogicalPathInput = z.object({ name: z.string().min(1).max(64) }).strict();

export function createFactoryMcpServer(deps: FactoryToolDeps, options: FactoryServerOptions = {}) {
  const connectionEnabled = options.connectionEnabled ?? true;
  const session = options.session ?? null;

  const server = new McpServer({ name: "youtube-operations-manager-factory", version: FACTORY_API_VERSION });

  function registerTool(
    name: (typeof FACTORY_TOOL_NAMES)[number],
    config: { description: string; inputSchema: z.ZodTypeAny },
    handler: (args: unknown) => Promise<ToolResponse>
  ) {
    if (!connectionEnabled || !session) return;
    const counted = async (args: unknown): Promise<ToolResponse> => {
      try {
        await session.reverify();
      } catch (error) {
        await deps.recordOutcome("blocked");
        return errorResult(
          error instanceof DomainError ? error : new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" })
        );
      }
      await deps.recordOutcome("allowed");
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(error);
      }
    };
    server.registerTool(name, config as never, counted as never);
  }

  registerTool(
    "factory_get_capabilities",
    {
      description:
        "Report this endpoint's factory API version, the tools actually callable by the Factory Operator role, and the permission this token holds (READ only). Call this first. A local read; no channel scoping, no YouTube call.",
      inputSchema: emptyInput,
    },
    async () =>
      successResult({
        role: "factory_operator",
        factoryApiVersion: FACTORY_API_VERSION,
        tools: [...FACTORY_TOOL_NAMES],
        permissions: ["READ"],
      })
  );

  registerTool(
    "factory_list_logical_paths",
    {
      description:
        "List every logical path defined in this app with THIS computer's value: { name, description, configured, path }. configured:false means no folder is set on this computer (never an empty path). Paths are text only: this app never opens or lists anything inside a folder. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ paths: await deps.listLogicalPaths() })
  );

  registerTool(
    "factory_get_logical_path",
    {
      description:
        "Get one logical path's value on THIS computer by name. Fails with LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE when the path exists but no folder is set on this computer (never returns an empty path), and with LOGICAL_PATH_NOT_FOUND for an unknown name. Read-only: a path can only be set by the operator in the app's Settings.",
      inputSchema: getLogicalPathInput,
    },
    async (args) => {
      const parsed = getLogicalPathInput.safeParse(args);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid MCP tool input",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
        });
      }
      return successResult(await deps.readLogicalPath(parsed.data));
    }
  );

  registerTool(
    "factory_list_channels",
    {
      description:
        "List the channels connected to this app: { channelId, title, workspace } where workspace is this computer's production-workspace folder path for the channel or { configured:false }. Contains no credentials, account identities, videos or analytics. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ channels: await deps.listChannels() })
  );

  return server;
}
