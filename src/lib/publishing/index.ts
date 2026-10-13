import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createChannelPublishingSettingsCoreForProduction } from "@/lib/sync-gateway";
import {
  clearPublishingG1Probe,
  getChannelExpectedLanguages,
  getLiveWritesEnabled,
  getPublishingG1Probe,
  insertVideoEditAuditEvent,
  getPublishingUpload,
  insertPublishingUploads,
  listPublishingUploads,
  listQuotaCalls,
  rawSqlClient,
  removeLocalVideoRowIfUnreferenced,
  savePublishingG1Probe,
  updatePublishingUpload,
} from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createVideoDetailsCore } from "@/lib/video-details";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { getQuotaLedgerSyncCore } from "@/lib/quota-ledger-sync";
import { nextYoutubeQuotaReset, startOfYoutubeQuotaDay } from "@/lib/youtube-quota";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, getVideoUploadState, listPlaylistItemIdsByVideo, listUploadsPlaylistFirstPage } from "@/lib/youtube-read-gateway";
import { createWorkspaceExchangeFsForPublishing, resolveWorkspaceFileForPublishing } from "./adapters/files";
import { createPackageFiles } from "./adapters/package-files";
import { createPackageScan, isPackageThumbnailPath, type PackageScanDeps } from "./package-scan";
import { imageKindOf } from "./packages";
import { authorizedOAuth, createPublishingFinishWrites, createPublishingYoutubeWrites, freshAccessToken } from "./adapters/youtube-writes";
import { ACTIVE_UPLOAD_STATUSES, createUploadRunner, isCancellable, type UploadRunnerDeps } from "./upload-runner";
import { createUploadApproval } from "./upload-approval";
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
    sha256: (absolutePath) => sha256OfFile(absolutePath),
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

/** A file's SHA-256, read as a stream (the same hash for the scan and for the upload's check that the package did not change). */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** This computer's id (bootstrap config) and host name, for the upload record; unreadable is "unknown", never a reason to stop. */
async function thisDevice(): Promise<{ deviceId: string | null; hostname: string | null }> {
  const deviceId = await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath)
    .read()
    .then((config) => config?.deviceId ?? null)
    .catch(() => null);
  let host: string | null = null;
  try {
    host = hostname() || null;
  } catch {
    host = null;
  }
  return { deviceId, hostname: host };
}

/** A channel's uploads playlist: its id with "UC" replaced by "UU" (the documented convention for a channel's uploads). */
const uploadsPlaylistOf = (channelId: string) => (channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId);

/**
 * BL-182 stage 2 (ADR 0037): the background upload runner of this computer. Every write goes through the write gateway right after
 * the Live writes check; every read through the read gateway; the deferred publish time through video-details' own write path.
 */
export function createUploadRunnerCore() {
  const workspaces = createChannelWorkspacesCore();
  const writeContext = createWriteContextCore();
  const uploads = createPublishingYoutubeWrites();
  const finish = createPublishingFinishWrites();
  const videoDetails = createVideoDetailsCore();
  const workspaceOf = async (channelId: string) => {
    const workspace = await workspaces.getWorkspace({ channelId });
    if (!workspace.configured) throw new Error("This channel has no workspace folder on this computer (Settings → Channels).");
    return workspace.path;
  };
  const deps: UploadRunnerDeps = {
    store: {
      listActive: () => listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 }),
      update: (id, from, set) => updatePublishingUpload(id, from, set),
    },
    async credentials(job) {
      const credentialRef = { userId: job.approvedBy };
      return { credentialRef, credentials: await resolveGoogleCredentials({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] }) };
    },
    async assertWriteChannel({ channelId, credentialRef, credentials }) {
      await writeContext.assertWriteChannel({ credentialRef, credentials: credentials as ResolvedCredentials, expectedChannelId: channelId });
    },
    accessToken: (credentials) => freshAccessToken(credentials as ResolvedCredentials),
    liveWritesEnabled: () => getLiveWritesEnabled(),
    gateway: {
      begin: (args) => uploads.begin(args),
      putChunk: (args) => uploads.putChunk(args),
      queryOffset: (args) => uploads.queryOffset(args),
      setThumbnail: (credentials, videoId, image) => finish.setThumbnail(credentials as ResolvedCredentials, videoId, image),
      addToPlaylist: (credentials, videoId, playlistId) => finish.addToPlaylist(credentials as ResolvedCredentials, videoId, playlistId),
    },
    reads: {
      uploadState: async (credentials, videoId) => getVideoUploadState(await createYoutubeClient(authorizedOAuth(credentials as ResolvedCredentials)), videoId),
      recentUploads: async (credentials, channelId) => listUploadsPlaylistFirstPage(await createYoutubeClient(authorizedOAuth(credentials as ResolvedCredentials)), uploadsPlaylistOf(channelId)),
      playlistHasVideo: async (credentials, playlistId, videoId) =>
        (await listPlaylistItemIdsByVideo(await createYoutubeClient(authorizedOAuth(credentials as ResolvedCredentials)), playlistId)).has(videoId),
      snapshot: async ({ channelId, videoId, credentialRef }) => videoDetails.getSnapshot({ credentialRef, expectedChannelId: channelId, videoId }),
    },
    async setPublishAt({ channelId, videoId, publishAt, containsSyntheticMedia, credentialRef }) {
      await videoDetails.applyFieldsUpdate({ credentialRef, expectedChannelId: channelId, videoId, patch: { privacyStatus: "private", publishAt, containsSyntheticMedia } });
    },
    files: {
      async resolve(channelId, relativePath) {
        try {
          const file = await resolveWorkspaceFileForPublishing({
            workspace: await workspaceOf(channelId),
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
      async readChunk(filePath, start, length) {
        const handle = await open(filePath, "r");
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          if (bytesRead !== length) throw new Error(`Read ${bytesRead} of ${length} bytes at ${start}.`);
          return buffer;
        } finally {
          await handle.close();
        }
      },
      sha256: (filePath) => sha256OfFile(filePath),
      /** Next to the package, inside the workspace (its real folder checked), written whole or not at all. */
      async writeRecord(channelId, relativePath, record) {
        const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
        if (!/^V\d+_youtube\.json$/.test(name)) throw new Error(`Not an upload record name: ${name}`);
        const workspace = await realpath(await workspaceOf(channelId));
        const folder = await realpath(path.join(workspace, ...relativePath.slice(0, relativePath.lastIndexOf("/")).split("/")));
        if (folder === workspace || !isPathInsideOrEqual(workspace, folder)) throw new Error("The package folder is outside the channel workspace.");
        const target = path.join(folder, name);
        const temporary = path.join(folder, `.${name}.${randomUUID()}.tmp`);
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporary, target);
      },
    },
    audit: ({ channelId, videoId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: videoId ?? `upload:${String(detail.uploadId ?? "")}`, eventType: "RESULT", detail }),
    async syncChannel({ channelId, credentialRef }) {
      await createChannelSyncCore().syncChannel({ credentialRef, channelId });
    },
    device: () => thisDevice(),
    clock: { now: () => new Date() },
    nextQuotaReset: (now) => nextYoutubeQuotaReset(now),
    chunkBytes: 32 * 256 * 1024, // 8 MB
    sliceMs: 50_000,
  };
  return createUploadRunner(deps);
}

/** `videos.insert` calls since the YouTube quota day began: this computer's log and the log shared by the others. */
async function videosInsertCallsSince(since: Date): Promise<number> {
  const sinceSeconds = Math.floor(since.getTime() / 1000);
  const inserts = (calls: ReadonlyArray<{ method: string }>) => calls.filter((call) => call.method === "videos.insert").length;
  let peers = 0;
  try {
    peers = inserts(await getQuotaLedgerSyncCore().readPeerCalls({ sinceSeconds, service: "data" }));
  } catch {
    // the shared log is a correction only
  }
  return inserts(await listQuotaCalls({ sinceSeconds, service: "data" })) + peers;
}

/** BL-182 stage 2: the owner's approval of release-package uploads (queued here; the runner sends them). */
export function createUploadApprovalCore() {
  const scan = createPackageScanCore();
  const settings = createPublishingSettingsCore();
  return createUploadApproval({
    scan: (channelId) => scan.scan(channelId),
    settings: (channelId) => settings.read(channelId),
    liveVideos: async (channelId) =>
      new Set((await listPublishingUploads({ channelId, statuses: [...ACTIVE_UPLOAD_STATUSES, "done"], limit: 500 })).map((row) => row.video)),
    insertsToday: (now) => videosInsertCallsSince(startOfYoutubeQuotaDay(now)),
    checkUnits: (units) => createQuotaGuardCore().checkUnits(units),
    insert: (rows) => insertPublishingUploads(rows),
    newId: () => randomUUID(),
    audit: ({ channelId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `upload:${String(detail.uploadId ?? "")}`, eventType: "RESULT", detail }),
    clock: { now: () => new Date() },
  });
}

/** The channel's uploads on this computer, newest first (the progress list in Content → «Публикация»). */
export async function listChannelUploads(channelId: string) {
  return listPublishingUploads({ channelId, limit: 100 });
}

/**
 * The owner cancels an upload that has not reached YouTube: a queued one, or one paused before its last byte. One whose video
 * exists (or may exist: every byte sent) is not cancelled -- it is finished, and the owner deletes the video in Studio if needed.
 */
export async function cancelUpload(channelId: string, uploadId: string): Promise<boolean> {
  const row = await getPublishingUpload(uploadId);
  if (!row || row.channelId !== channelId) return false;
  if (!isCancellable(row)) return false;
  const done = await updatePublishingUpload(uploadId, row.status, { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() });
  if (done) await insertVideoEditAuditEvent({ channelId, videoId: `upload:${uploadId}`, eventType: "RESULT", detail: { event: "publishing.upload_cancelled", uploadId, video: row.video } });
  return done;
}
export type { UploadRunner, UploadSteps, ApprovedPackage } from "./upload-runner";
