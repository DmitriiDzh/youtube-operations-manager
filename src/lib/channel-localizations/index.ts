import { getChannelExpectedLanguages, getChannelLocalizationsRow, getStoredChannel, insertChannelLocalizationEvent, saveChannelLocalizationsLastApply, saveChannelLocalizationsSet } from "@/lib/db";
import { createBackupCore } from "@/lib/backup";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { sleep } from "@/lib/shared-async";
import { createIdGenerator } from "@/lib/shared-domain";
import { createWriteContextCore } from "@/lib/write-context";
import { createChannelLocalizationsYoutubeAdapter } from "./adapters/youtube-api";
import { createChannelLocalizationsService, type ChannelLocalizationsService } from "./services";

export type {
  ChannelLocalizationsActor,
  ChannelLocalizationsDependencies,
  ChannelLocalizationsLastApply,
  ChannelLocalizationsPreviewView,
  ChannelLocalizationsView,
} from "./contracts";
export { createChannelLocalizationsService, CHANNEL_LOCALIZATIONS_READ_BACK, type ChannelLocalizationsService } from "./services";
export * from "./set";

/**
 * BL-210 (ADR 0047): the channel translations service wired to its real adapters. The audit is the module's own append-only trail
 * (`channel_localization_events`, v104); the backup goes to the shared backup store under the channel id.
 */
function createProductionService(): ChannelLocalizationsService {
  const newId = createIdGenerator();
  return createChannelLocalizationsService({
    store: {
      get: async (channelId) => getChannelLocalizationsRow(channelId),
      saveSet: (channelId, set) => saveChannelLocalizationsSet(channelId, set),
      saveLastApply: (channelId, result) => saveChannelLocalizationsLastApply(channelId, result),
    },
    channel: async (channelId) => {
      const channel = await getStoredChannel(channelId);
      return channel ? { connectedUserId: channel.connectedUserId ?? null } : null;
    },
    baselineLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
    auth: { resolve: (args) => resolveGoogleCredentials(args as Parameters<typeof resolveGoogleCredentials>[0]) },
    writeContext: {
      assertWriteChannel: (args) => createWriteContextCore().assertWriteChannel(args as Parameters<ReturnType<typeof createWriteContextCore>["assertWriteChannel"]>[0]),
    },
    youtube: createChannelLocalizationsYoutubeAdapter(),
    backup: {
      checkInfrastructureHealth: () => createBackupCore().checkInfrastructureHealth(),
      captureBackup: (args) => createBackupCore().captureBackup({ channelId: args.channelId, operationId: args.operationId, videoId: args.subjectId, snapshot: args.snapshot }),
    },
    audit: { record: (args) => insertChannelLocalizationEvent({ id: newId(), channelId: args.channelId, at: new Date(), kind: args.kind, detailJson: JSON.stringify(args.detail) }) },
    sleep: (ms) => sleep(ms),
    clock: () => new Date(),
    newId,
  });
}

/** The owner's surface (the Web UI routes only): view, save, preview and «Применить». */
export function createChannelLocalizationsOwnerCore(): ChannelLocalizationsService {
  return createProductionService();
}

/**
 * The Factory Operator's surface (AC-CL-10): the stored set, the live translations and saving -- never the apply. Built by
 * `operatorSurface`, so the object handed to the MCP layer has no path to a YouTube write.
 */
export function operatorSurface(service: Pick<ChannelLocalizationsService, "view" | "save" | "live">) {
  return {
    view: (channelId: string) => service.view(channelId),
    live: (channelId: string) => service.live(channelId),
    save: (channelId: string, input: unknown) => service.save(channelId, input, "factory"),
  };
}

export function createChannelLocalizationsOperatorCore() {
  return operatorSurface(createProductionService());
}
