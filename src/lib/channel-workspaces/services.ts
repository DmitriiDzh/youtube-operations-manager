import type { WorkspacePathValidationResult } from "@/lib/local-path-validation/services";
import { DomainError } from "./contracts";
import type { ChannelWorkspaceListEntry, ChannelWorkspaceResult } from "./contracts";
import { getChannelWorkspaceInputSchema, parseWithSchema, setChannelWorkspaceInputSchema } from "./schemas";

export type ChannelWorkspaceStore = {
  get(deviceId: string, channelId: string): Promise<string | null>;
  list(deviceId: string): Promise<Array<{ channelId: string; path: string; updatedAt: Date }>>;
  /** `null` deletes this device's row for the channel. */
  set(deviceId: string, channelId: string, path: string | null): Promise<void>;
};

export type ServiceDependencies = {
  /** This installation's bootstrap `deviceId`, or `null` if none exists yet. Used by every READ:
   * a read must never create the device identity as a side effect (the agent-facing read is
   * deliberately outside the MCP mutation gate). No deviceId means no row can exist for this
   * device yet, so reads answer "not configured". */
  readDeviceId(): Promise<string | null>;
  /** Same `deviceId`, created on first use -- used ONLY by the operator-facing write. */
  ensureDeviceId(): Promise<string>;
  store: ChannelWorkspaceStore;
  /** Every channel currently connected on this installation (`src/lib/channel-connections`). */
  listConnectedChannelIds(): Promise<string[]>;
  /** Set-time only (`src/lib/local-path-validation`). Deliberately NOT used by any read below:
   * a read returns the stored string and never touches the workspace path (AC-P11-09). */
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
};

export function createChannelWorkspacesServices(deps: ServiceDependencies) {
  async function requireConnectedChannel(channelId: string): Promise<void> {
    const connected = await deps.listConnectedChannelIds();
    if (!connected.includes(channelId)) {
      throw new DomainError({
        code: "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED",
        message: "channelId is not one of this installation's connected channels",
        details: { channelId },
      });
    }
  }

  return {
    /**
     * Agent-facing read (also used by the operator UI). A store lookup that never touches anything
     * at or under the workspace path (the only file involved is reading this app's own bootstrap
     * config for the `deviceId`, never creating it). Channel scoping (active channel) is the MCP/CLI caller's job, same convention as
     * `agent-operations`' `getChannelContext`.
     */
    async getWorkspace(input: unknown): Promise<ChannelWorkspaceResult> {
      const { channelId } = parseWithSchema(getChannelWorkspaceInputSchema, input, "get channel workspace input");
      const deviceId = await deps.readDeviceId();
      const path = deviceId ? await deps.store.get(deviceId, channelId) : null;
      return path ? { configured: true, path } : { configured: false };
    },

    /** Operator Settings view: one entry per connected channel, `path: null` when unset. Rows for
     * channels no longer connected are not listed (they stay stored, harmlessly, and reappear if
     * the channel is reconnected). */
    async listWorkspaces(): Promise<ChannelWorkspaceListEntry[]> {
      const deviceId = await deps.readDeviceId();
      const [connected, stored] = await Promise.all([
        deps.listConnectedChannelIds(),
        deviceId ? deps.store.list(deviceId) : Promise.resolve([]),
      ]);
      const byChannel = new Map(stored.map((row) => [row.channelId, row]));
      return connected.map((channelId) => {
        const row = byChannel.get(channelId);
        return { channelId, path: row?.path ?? null, updatedAt: row ? row.updatedAt.toISOString() : null };
      });
    },

    /**
     * Operator-only write -- never reachable from an agent surface. Validates the path once, at set
     * time (absolute, exists, is a directory, does not overlap the app-data directory). Nothing is
     * stored when validation fails. `null`/blank clears.
     */
    async setWorkspace(input: unknown): Promise<ChannelWorkspaceResult> {
      const parsed = parseWithSchema(setChannelWorkspaceInputSchema, input, "set channel workspace input");
      await requireConnectedChannel(parsed.channelId);
      const deviceId = await deps.ensureDeviceId();

      const candidate = parsed.path?.trim() ?? "";
      if (candidate === "") {
        await deps.store.set(deviceId, parsed.channelId, null);
        return { configured: false };
      }

      const validation = await deps.validatePath(candidate);
      if (!validation.ok) {
        throw new DomainError({
          code: "CHANNEL_WORKSPACE_PATH_INVALID",
          message: `workspace path rejected: ${validation.reason}`,
          details: { channelId: parsed.channelId, reason: validation.reason },
        });
      }
      await deps.store.set(deviceId, parsed.channelId, candidate);
      return { configured: true, path: candidate };
    },
  };
}

export type ChannelWorkspacesServices = ReturnType<typeof createChannelWorkspacesServices>;
