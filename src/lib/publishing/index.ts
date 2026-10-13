import { open } from "node:fs/promises";
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createChannelPublishingSettingsCoreForProduction } from "@/lib/sync-gateway";
import { clearPublishingG1Probe, getPublishingG1Probe, insertVideoEditAuditEvent, rawSqlClient, removeLocalVideoRowIfUnreferenced, savePublishingG1Probe } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, getVideoUploadState } from "@/lib/youtube-read-gateway";
import { createWorkspaceExchangeFsForPublishing, resolveWorkspaceFileForPublishing } from "./adapters/files";
import { authorizedOAuth, createPublishingYoutubeWrites, freshAccessToken } from "./adapters/youtube-writes";
import type { G1ProbeRecord } from "./contracts";
import { createPublishingCalendarReads } from "./calendar-reads";
import { createG1Probe } from "./g1-probe";
import { createPublishingSettingsService } from "./settings-service";

/** The stored record, only when it has this module's shape (an older or damaged value counts as "started": it blocks). */
function asProbeRecord(value: unknown): G1ProbeRecord | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Partial<G1ProbeRecord>;
  if (typeof record.channelId !== "string") return null;
  return {
    channelId: record.channelId,
    status: record.status === "uploaded" ? "uploaded" : "started",
    attempt: typeof record.attempt === "number" ? record.attempt : 1,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "unknown",
    videoId: typeof record.videoId === "string" ? record.videoId : null,
    uploadedAt: typeof record.uploadedAt === "string" ? record.uploadedAt : null,
    deletedAt: typeof record.deletedAt === "string" ? record.deletedAt : null,
    rejectionReason: typeof record.rejectionReason === "string" ? record.rejectionReason : null,
  };
}

// BL-182 (ADR 0037). A feature module of its own (AGENTS.md §M): only the developer-only G1 probe for now (stage 0).

export function createG1ProbeCore(options: { announce?: (videoId: string) => void } = {}) {
  const writeContext = createWriteContextCore();
  const workspaces = createChannelWorkspacesCore();
  return createG1Probe({
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    resolveWriteCredentials: (credentialRef) => resolveGoogleCredentials({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] }),
    async assertWriteChannel(args) {
      await writeContext.assertWriteChannel(args);
    },
    async resolveFile(channelId, relativePath) {
      const workspace = await workspaces.getWorkspace({ channelId });
      if (!workspace.configured) throw new Error("This channel has no workspace folder on this computer (Settings → Channels).");
      const file = await resolveWorkspaceFileForPublishing({
        workspace: workspace.path,
        relativePath,
        fs: createWorkspaceExchangeFsForPublishing(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
      return { path: file.path, bytes: file.bytes };
    },
    async readChunk(path, start, length) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (bytesRead !== length) throw new Error(`Read ${bytesRead} of ${length} bytes at ${start}.`);
        return buffer;
      } finally {
        await handle.close();
      }
    },
    accessTokenOf: (credentials) => freshAccessToken(credentials),
    gateway: createPublishingYoutubeWrites(),
    readState: async (credentials, videoId) => getVideoUploadState(await createYoutubeClient(authorizedOAuth(credentials)), videoId),
    record: { get: async () => asProbeRecord(await getPublishingG1Probe()), save: (record) => savePublishingG1Probe(record), clear: () => clearPublishingG1Probe() },
    announce: (videoId) => options.announce?.(videoId),
    audit: ({ channelId, videoId, detail }) => insertVideoEditAuditEvent({ channelId, videoId, eventType: "RESULT", detail }),
    removeLocalVideoRow: (channelId, videoId) => removeLocalVideoRowIfUnreferenced(channelId, videoId),
    clock: { now: () => new Date() },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

/** BL-182 stage 1: the publishing calendar and the 7-day reminder, from the local copy only. */
export function createPublishingCalendarCore() {
  const store = createChannelVideoStoreAdapter();
  return createPublishingCalendarReads({
    async listVideos(channelId) {
      return (await store.listVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        privacyStatus: video.privacyStatus,
        publishedAt: video.publishedAt,
        publishAt: video.publishAt,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        syncedAtMs: video.lastSyncedAt.getTime(),
      }));
    },
    getChannel: (channelId) => store.getChannel(channelId),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    clock: { now: () => new Date() },
  });
}

export type PublishingCalendarCore = ReturnType<typeof createPublishingCalendarCore>;

/** BL-182 stage 2: the channel's publishing defaults, synced between computers (Content → «Публикация»). */
export function createPublishingSettingsCore() {
  return createPublishingSettingsService({ store: createChannelPublishingSettingsCoreForProduction() });
}
export type { PublishingSettingsService, PublishingSettingsView } from "./settings-service";
export type { PublishingLicense, PublishingSettingField, PublishingSettings } from "./settings";
export {
  DEFAULT_PUBLISHING_SETTINGS,
  isPublishingSettingField,
  parsePublishingSettingsPatch,
  PUBLISHING_LICENSES,
  PUBLISHING_SETTING_FIELDS,
  VIDEO_CATEGORY_IDS,
} from "./settings";
export type { G1DeleteReport, G1ProbeRecord, G1UploadReport } from "./contracts";
export type { CalendarEntry, CalendarEntryKind, PublishingCoverage } from "./calendar";
export type { AgentPublishingCalendar, PublishingAlert, PublishingCalendarResult } from "./calendar-reads";
export { PUBLISHING_REMINDER_DAYS } from "./calendar";
