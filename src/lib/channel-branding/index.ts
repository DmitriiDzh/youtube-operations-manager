import { createHash } from "node:crypto";
import path from "node:path";
import { createBackupCore } from "@/lib/backup";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getChannelBrandingRow, getStoredChannel, insertChannelBrandingEvent, saveChannelBrandingDraft, saveChannelBrandingLastApply } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { sleep } from "@/lib/shared-async";
import { createIdGenerator } from "@/lib/shared-domain";
import { createExchangeFs, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createWriteContextCore } from "@/lib/write-context";
import { createBannerStore } from "./adapters/banner-store";
import { readFileCapped } from "./adapters/workspace-file";
import { CHANNEL_BANNER_MAX_BYTES } from "./draft";
import { createChannelBrandingYoutubeAdapter } from "./adapters/youtube-api";
import type { ChannelBannerInput, ChannelBrandingActor, ChannelBrandingDependencies } from "./contracts";
import { createChannelBrandingService, type ChannelBrandingService } from "./services";

export type {
  ChannelBrandingActor,
  ChannelBrandingDependencies,
  ChannelBrandingGetView,
  ChannelBrandingLastApply,
  ChannelBrandingLive,
  ChannelBrandingPreview,
  ChannelBrandingView,
} from "./contracts";
export { CHANNEL_BRANDING_READ_BACK, createChannelBrandingService, type ChannelBrandingService } from "./services";
export * from "./draft";

/** `<app data>/channel-branding/`: the drafts' banners (one folder per channel). */
export function channelBrandingDir(): string {
  return path.join(getProductionAppPaths().appDataDir, "channel-branding");
}

/** An agent's banner: a regular file inside the channel workspace's `99 Data Exchange/Sent to YTM/` (the shared rules). */
async function workspaceFile(channelId: string, relativePath: string): Promise<{ size: number; read(): Promise<Buffer> }> {
  const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
  if (!workspace.configured) throw new Error("this channel has no workspace folder on this computer (Settings → Channels)");
  const file = await resolveSentToYtmFile({
    workspace: workspace.path,
    relativePath,
    fs: createExchangeFs(),
    validateWorkspacePath: validateOperatorDirectoryPath,
    isPathInsideOrEqual,
    unavailable: (reason) => new Error(reason),
  });
  // Review #3: read from one opened handle, the resolver's dev/ino checked, at most 6 MB + 1 byte.
  return { size: file.bytes, read: () => readFileCapped(file.path, file.identity, CHANNEL_BANNER_MAX_BYTES) };
}

/**
 * BL-223 (ADR 0050): the channel branding service wired to its real adapters. The audit is the module's own append-only trail
 * (`channel_branding_events`, v109); the backup goes to the shared backup store under the channel id.
 */
function createProductionService(): ChannelBrandingService {
  const newId = createIdGenerator();
  const deps: ChannelBrandingDependencies = {
    store: {
      get: async (channelId) => getChannelBrandingRow(channelId),
      saveDraft: (channelId, draft) => saveChannelBrandingDraft(channelId, draft),
      saveLastApply: (channelId, result) => saveChannelBrandingLastApply(channelId, result),
    },
    banners: createBannerStore(channelBrandingDir()),
    workspaceFile,
    channel: async (channelId) => {
      const channel = await getStoredChannel(channelId);
      return channel ? { connectedUserId: channel.connectedUserId ?? null } : null;
    },
    auth: { resolve: (args) => resolveGoogleCredentials(args as Parameters<typeof resolveGoogleCredentials>[0]) },
    writeContext: {
      assertWriteChannel: (args) => createWriteContextCore().assertWriteChannel(args as Parameters<ReturnType<typeof createWriteContextCore>["assertWriteChannel"]>[0]),
    },
    youtube: createChannelBrandingYoutubeAdapter(),
    backup: {
      checkInfrastructureHealth: () => createBackupCore().checkInfrastructureHealth(),
      captureBackup: (args) => createBackupCore().captureBackup({ channelId: args.channelId, operationId: args.operationId, videoId: args.subjectId, snapshot: args.snapshot }),
    },
    audit: { record: (args) => insertChannelBrandingEvent({ id: newId(), channelId: args.channelId, at: new Date(), kind: args.kind, detailJson: JSON.stringify(args.detail) }) },
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
    sleep: (ms) => sleep(ms),
    clock: () => new Date(),
    newId,
  };
  return createChannelBrandingService(deps);
}

/** The owner's surface (the Web UI routes only): get, save, the banner bytes, preview and «Применить». */
export function createChannelBrandingOwnerCore(): ChannelBrandingService {
  return createProductionService();
}

/** An agent's save input as the MCP tools take it (the banner as a workspace path; `keepBanner` keeps the stored one). */
export type AgentChannelBrandingInput = { channelId: string; description?: string; keywords?: string[]; bannerFile?: string; keepBanner?: boolean };

/**
 * The agents' surface (AC-CB-09): the stored draft, the channel on YouTube and saving -- never the apply. Built by `agentSurface`,
 * so the object handed to the MCP layer has no path to a YouTube write. `by`: the Factory Operator or a channel's worker.
 */
export function agentSurface(service: Pick<ChannelBrandingService, "get" | "save">) {
  return {
    get: (channelId: string) => service.get(channelId),
    save: (input: AgentChannelBrandingInput, by: Extract<ChannelBrandingActor, "factory" | "worker">) => {
      const banner: ChannelBannerInput | undefined = input.bannerFile !== undefined ? { kind: "workspace", path: input.bannerFile } : input.keepBanner ? { kind: "keep" } : undefined;
      return service.save(input.channelId, { description: input.description, keywords: input.keywords, banner }, by);
    },
  };
}

export type ChannelBrandingAgentSurface = ReturnType<typeof agentSurface>;

/**
 * `factory_channel_get_branding` / `agent_channel_get_branding` (AC-CB-10): the stored draft, the channel on YouTube read now (1 unit;
 * when impossible, `live: null` with the code) and the last apply -- in codes, never the owner's error text or a path.
 */
export async function agentChannelBranding(surface: ChannelBrandingAgentSurface, channelId: string): Promise<Record<string, unknown>> {
  const view = await surface.get(channelId);
  const last = view.lastApply;
  return {
    channelId,
    stored: { draft: view.draft, problem: view.problem === null ? null : "invalid_stored", updatedAt: view.updatedAt, updatedBy: view.updatedBy },
    live: view.live,
    liveUnavailable: view.liveUnavailable,
    lastApply: last
      ? {
          at: last.at,
          ok: last.ok,
          fields: last.fields,
          writes: last.writes,
          bannerUrl: last.banner?.url ?? null,
          ...(last.ok ? {} : { failure: last.failure, ...(last.failure === "read_back_mismatch" ? {} : { code: last.detail }) }),
        }
      : null,
  };
}

export function createChannelBrandingAgentCore(): ChannelBrandingAgentSurface {
  return agentSurface(createProductionService());
}
