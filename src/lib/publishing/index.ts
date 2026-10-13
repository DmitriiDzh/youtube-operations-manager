import { open } from "node:fs/promises";
import path from "node:path";
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createChannelPublishingSettingsCoreForProduction } from "@/lib/sync-gateway";
import { clearPublishingG1Probe, getChannelExpectedLanguages, getPublishingG1Probe, insertVideoEditAuditEvent, rawSqlClient, removeLocalVideoRowIfUnreferenced, savePublishingG1Probe } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, getVideoUploadState } from "@/lib/youtube-read-gateway";
import { createWorkspaceExchangeFsForPublishing, resolveWorkspaceFileForPublishing } from "./adapters/files";
import { createPackageFiles } from "./adapters/package-files";
import { createPackageScan, isPackageThumbnailPath, type PackageScanDeps } from "./package-scan";
import { imageKindOf } from "./packages";
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

// ffprobe is looked up once per process; a probed duration is kept per file and size (a finished video does not change).
const scanHolder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const FFMPEG_KEY = Symbol.for("ytom.publishing.ffmpeg");
const PROBE_CACHE_KEY = Symbol.for("ytom.publishing.probeCache");

/** BL-182 stage 2: the channel's release packages under `04 Videos/`, checked again (Content → «Публикация»). Read-only. */
export function createPackageScanCore() {
  const scan = createPackageScanReads();
  const files = createPackageFiles();
  return {
    scan: (channelId: string) => scan.reads.scan(channelId),
    /**
     * A package's thumbnail for the preview: only an image under `04 Videos/` of the channel's workspace, reached through the
     * workspace rule, at most 10 MB; its type is read from its first bytes, never from its name. Null when it is none of that.
     */
    async readThumbnail(channelId: string, relativePath: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
      if (!isPackageThumbnailPath(relativePath)) return null;
      const workspace = await scan.workspace(channelId);
      if (!workspace) return null;
      const file = await scan.resolveFile(workspace, relativePath);
      if (!file || file.bytes > 10 * 1024 * 1024) return null;
      const bytes = await files.readHead(file.path, file.bytes);
      const kind = imageKindOf(bytes);
      return kind === "other" ? null : { bytes, contentType: kind === "png" ? "image/png" : "image/jpeg" };
    },
  };
}

function createPackageScanReads() {
  const workspaces = createChannelWorkspacesCore();
  const files = createPackageFiles();
  const videoStore = createChannelVideoStoreAdapter();
  const probeCache = (scanHolder[PROBE_CACHE_KEY] ??= new Map<string, number | null>()) as Map<string, number | null>;
  const ffmpeg = () => (scanHolder[FFMPEG_KEY] ??= detectFfmpeg()) as Promise<FfmpegTools | null>;
  const deps: PackageScanDeps = {
    async workspace(channelId) {
      const workspace = await workspaces.getWorkspace({ channelId });
      return workspace.configured ? workspace.path : null;
    },
    validateWorkspace: async (workspace) => {
      const result = await validateOperatorDirectoryPath(workspace);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    listDir: (absolutePath) => files.listDir(absolutePath),
    async resolveFile(workspace, relativePath) {
      try {
        const file = await resolveWorkspaceFileForPublishing({
          workspace,
          relativePath,
          fs: createWorkspaceExchangeFsForPublishing(),
          validateWorkspacePath: validateOperatorDirectoryPath,
          isPathInsideOrEqual,
          unavailable: (reason) => new Error(reason),
        });
        return { path: file.path, bytes: file.bytes };
      } catch {
        return null;
      }
    },
    readText: (absolutePath, maxBytes) => files.readText(absolutePath, maxBytes),
    readHead: (absolutePath, length) => files.readHead(absolutePath, length),
    async probeDuration(absolutePath, bytes) {
      const key = `${absolutePath}|${bytes}`;
      if (probeCache.has(key)) return probeCache.get(key) ?? null;
      const tools = await ffmpeg();
      if (!tools) return "no_ffprobe";
      const duration = await probeMedia(tools, absolutePath).then((probe) => probe.durationSeconds).catch(() => null);
      probeCache.set(key, duration);
      return duration;
    },
    async channel(channelId) {
      const baseline = await getChannelExpectedLanguages(channelId);
      return { channelId, defaultLanguage: baseline.defaultLanguage, defaultAudioLanguage: baseline.defaultAudioLanguage };
    },
    async videos(channelId) {
      return (await videoStore.listVideosByChannel(channelId)).map((video) => ({ videoId: video.videoId, title: video.title, privacyStatus: video.privacyStatus, publishAt: video.publishAt }));
    },
    join: (...parts) => path.join(...parts),
    clock: { now: () => new Date() },
  };
  return { reads: createPackageScan(deps), workspace: deps.workspace, resolveFile: deps.resolveFile };
}
export type { PackageScanResult, PackageState, ScannedPackage } from "./package-scan";
export type { PackageProblem, ReleasePackage } from "./packages";

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
