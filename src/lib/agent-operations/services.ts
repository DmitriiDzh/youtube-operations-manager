import {
  AGENT_API_VERSION,
  DomainError,
  GRANTED_PERMISSIONS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
  type AgentCapabilityDescriptor,
  type AgentDataDomain,
  type ChannelContext,
  type SystemCapabilities,
  type VideoContext,
  type VideoContextSection,
} from "./contracts";
import {
  ALL_VIDEO_CONTEXT_SECTIONS,
  channelContextOutputSchema,
  getChannelContextInputSchema,
  getSystemCapabilitiesInputSchema,
  getVideoContextInputSchema,
  parseWithSchema,
  systemCapabilitiesOutputSchema,
  videoContextOutputSchema,
} from "./schemas";

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
  {
    id: "channel_context.get_channel_context",
    domain: "channel_context",
    permission: "READ",
    description:
      "Read-only channel context: title, sync status, synced video count, editorial profile, and tracked languages. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "video_context.get_video_context",
    domain: "video_context",
    permission: "READ",
    description:
      "Task-oriented, section-selectable video context (metadata and/or existing localizations). Requires channelId to be the caller's currently-active channel.",
  },
];

const AGENT_DATA_DOMAINS: AgentDataDomain[] = ["channel_metadata", "video_metadata"];

type StoredChannelForContext = {
  channelId: string;
  title: string;
  lastSyncedAt: Date | null;
};

type StoredVideoForContext = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
  lastSyncedAt: Date;
};

type StoredEditorialProfileForContext = {
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

type ServiceDependencies = {
  getProductVersion(): string;
  getSchemaVersion(): number;
  // Slice B -- reused unchanged from `changesets`' own channel/video store adapter
  // (`createChangeSetChannelStoreAdapter`), the same local-sync mirror `ai-localization` already
  // reads (AGENTS.md §D: no parallel read path).
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelForContext | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoForContext[]>;
  };
  // Delegates to `ai-localization`'s own `getEditorialProfile` service function unchanged --
  // never a second read of `channel_editorial_profiles`.
  getEditorialProfile(channelId: string): Promise<StoredEditorialProfileForContext | null>;
  // Delegates to `src/lib/db.ts`'s `getChannelTargetLanguages` (the same function
  // `src/lib/localization/` itself reads) -- never a second parser of `target_languages_json`.
  getTrackedLanguages(channelId: string): Promise<string[]>;
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

    /**
     * Slice B, owner spec §7. Channel-scoping (verifying `channelId` is the caller's active
     * channel) is deliberately NOT done here -- this module's schemas carry no `credentialRef`,
     * mirroring `ai-localization`'s own convention, so the MCP/CLI callers do that check
     * themselves before ever calling this function (see `src/mcp/server.ts`'s
     * `agentGetChannelContext` handler for the actual `assertActiveChannel` call).
     */
    async getChannelContext(input: unknown): Promise<ChannelContext> {
      const parsedInput = parseWithSchema(getChannelContextInputSchema, input, "get channel context input");

      const channel = await deps.channelStore.getChannel(parsedInput.channelId);
      if (!channel) {
        throw new DomainError({
          code: "DATA_NOT_SYNCED",
          message: "Channel has not been synchronized yet",
          details: { channelId: parsedInput.channelId },
        });
      }

      const [videos, profile, trackedLanguages] = await Promise.all([
        deps.channelStore.listVideosByChannel(channel.channelId),
        deps.getEditorialProfile(channel.channelId),
        deps.getTrackedLanguages(channel.channelId),
      ]);

      const output: ChannelContext = {
        channelId: channel.channelId,
        title: channel.title,
        lastSyncedAt: channel.lastSyncedAt ? channel.lastSyncedAt.toISOString() : null,
        syncedVideoCount: videos.length,
        editorialProfile: profile,
        trackedLanguages,
      };

      return parseWithSchema(channelContextOutputSchema, output, "get channel context output");
    },

    /**
     * Slice B, owner spec §8. Same channel-scoping note as `getChannelContext` above -- enforced
     * by the caller (MCP/CLI), not here. `include` selects which sections are computed and
     * returned (owner spec §23: "Optimize for repeatable agent workflows and token efficiency");
     * omitted = every section this slice supports (`ALL_VIDEO_CONTEXT_SECTIONS`).
     */
    async getVideoContext(input: unknown): Promise<VideoContext> {
      const parsedInput = parseWithSchema(getVideoContextInputSchema, input, "get video context input");
      const sections: VideoContextSection[] = parsedInput.include ?? [...ALL_VIDEO_CONTEXT_SECTIONS];

      const videos = await deps.channelStore.listVideosByChannel(parsedInput.channelId);
      const video = videos.find((v) => v.videoId === parsedInput.videoId);
      if (!video) {
        throw new DomainError({
          code: "DATA_NOT_SYNCED",
          message: "video_id does not belong to this channel's synchronized data (wrong channel, or not synced)",
          details: { channelId: parsedInput.channelId, videoId: parsedInput.videoId },
        });
      }

      const output: VideoContext = {
        videoId: video.videoId,
        channelId: video.channelId,
        includedSections: sections,
      };

      if (sections.includes("metadata")) {
        output.metadata = {
          videoId: video.videoId,
          channelId: video.channelId,
          title: video.title,
          description: video.description,
          publishedAt: video.publishedAt,
          privacyStatus: video.privacyStatus,
          defaultLanguage: video.defaultLanguage,
          defaultAudioLanguage: video.defaultAudioLanguage,
          lastSyncedAt: video.lastSyncedAt.toISOString(),
        };
      }

      if (sections.includes("localizations")) {
        output.localizations = Object.entries(video.existingLocalizations).map(([language, value]) => ({
          language,
          title: value.title,
          description: value.description,
        }));
      }

      return parseWithSchema(videoContextOutputSchema, output, "get video context output");
    },
  };
}

export type AgentOperationsServices = ReturnType<typeof createAgentOperationsServices>;
