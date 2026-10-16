import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  createChannelPublishingSettingsCoreForProduction,
  createPublishingUploadsShareCoreForProduction,
  PUBLISHING_UPLOADS_REPORT_FORMAT,
  PUBLISHING_UPLOADS_REPORT_VERSION,
} from "@/lib/sync-gateway";
import {
  clearPublishingG1Probe,
  getChannelExpectedLanguages,
  getLiveWritesEnabled,
  getPublishingG1Probe,
  insertVideoEditAuditEvent,
  claimPublishingUpload,
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
import { createWorkspaceExchangeFsForPublishing, resolveWorkspaceFileForPublishing, writeVideoFolderFile } from "./adapters/files";
import { createWorkspaceVideoFiles } from "@/lib/workspace-videos";
import { createPackageScan, isPackageThumbnailPath, VIDEOS_FOLDER, type PackageScanDeps } from "./package-scan";
import { imageKindOf } from "./packages";
import { createPackageComposer } from "./package-composer";
import { authorizedOAuth, createPublishingFinishWrites, createPublishingYoutubeWrites, freshAccessToken } from "./adapters/youtube-writes";
import { ACTIVE_UPLOAD_STATUSES, createUploadRunner, holdsPackage, isCancellable, UNKNOWN_OUTCOME_RELEASED, type UploadRunnerDeps } from "./upload-runner";
import { createUploadApproval } from "./upload-approval";
import { estimateUploadUnits, isDeferredPublishAt } from "./publish-dates";
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
    async packages(channelId) {
      const result = await createPackageScanCore().scan(channelId);
      if (result.status !== "ok") return { status: result.status === "no_workspace" ? "no_workspace" : "unavailable" };
      return {
        status: "ok",
        items: result.packages.map((p) => ({ video: p.video, title: p.title, plannedPublishDate: p.plannedPublishDate, state: p.state, problems: p.problems.map((problem) => problem.code), videoId: p.youtube?.videoId ?? null })),
      };
    },
    async uploads(channelId) {
      return (await listChannelUploads(channelId)).map((row) => ({ video: row.video, status: row.status, publishAt: row.publishAt, videoId: row.videoId, pausedReason: row.pausedReason, errorCode: row.errorCode }));
    },
  });
}

export type PublishingCalendarCore = ReturnType<typeof createPublishingCalendarCore>;

// ffprobe is looked up once per process once found (until then, on every check); a probed duration is kept per file and
// size (a finished video does not change).
const scanHolder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const FFMPEG_KEY = Symbol.for("ytom.publishing.ffmpeg");
const PROBE_CACHE_KEY = Symbol.for("ytom.publishing.probeCache");

/** BL-182 stage 2: the channel's release packages under `04 Videos/`, checked again (Content → «Публикация»). Read-only. */
export function createPackageScanCore() {
  const scan = createPackageScanReads();
  const files = createWorkspaceVideoFiles();
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
      // The file's real path must be inside the real `04 Videos/`: a symlink there must not serve another workspace image (review).
      const videosRoot = await realpath(path.join(workspace, VIDEOS_FOLDER)).catch(() => null);
      if (!videosRoot || !isPathInsideOrEqual(videosRoot, file.path)) return null;
      const bytes = await files.readHead(file.path, file.bytes);
      const kind = imageKindOf(bytes);
      return kind === "other" ? null : { bytes, contentType: kind === "png" ? "image/png" : "image/jpeg" };
    },
  };
}

function createPackageScanReads() {
  const workspaces = createChannelWorkspacesCore();
  const files = createWorkspaceVideoFiles();
  const videoStore = createChannelVideoStoreAdapter();
  const probeCache = (scanHolder[PROBE_CACHE_KEY] ??= new Map<string, number | null>()) as Map<string, number | null>;
  const ffmpeg = async () => {
    const found = await ((scanHolder[FFMPEG_KEY] ??= detectFfmpeg()) as Promise<FfmpegTools | null>);
    if (!found) scanHolder[FFMPEG_KEY] = undefined; // look again next time (ffmpeg may be installed meanwhile)
    return found;
  };
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
  return { reads: createPackageScan(deps), workspace: deps.workspace, resolveFile: deps.resolveFile, deps };
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
      claim: (id, owner, until, now) => claimPublishingUpload(id, owner, until, now),
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
    runnerId: `${hostname()}:${process.pid}:${randomUUID()}`,
  };
  const runner = createUploadRunner(deps);
  const share = createPublishingUploadsShareCoreForProduction();
  let published = { key: "", at: 0 };
  /** This computer's uploads under way, for the other computer (ADR 0037 §4); written when they change, refreshed every 5 minutes. */
  async function publishReport(): Promise<void> {
    // Every row that holds its package: under way, or done / failed with a video (review B1) -- the other computer must refuse those too.
    const uploads = (await listPublishingUploads({ limit: 500 }))
      .filter(holdsPackage)
      .map((row) => ({
        channelId: row.channelId,
        video: row.video,
        state: (ACTIVE_UPLOAD_STATUSES as readonly string[]).includes(row.status) ? (row.status as "queued" | "uploading" | "processing" | "finishing" | "paused") : ("uploaded" as const),
      }));
    const key = JSON.stringify(uploads);
    if (key === published.key && Date.now() - published.at < 5 * 60_000) return;
    const device = await thisDevice();
    const deviceId = (await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath).ensureExists()).deviceId;
    const hostName = (device.hostname ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 64) || null;
    await share.publishLocalReport({ format: PUBLISHING_UPLOADS_REPORT_FORMAT, version: PUBLISHING_UPLOADS_REPORT_VERSION, deviceId, hostName, updatedAt: new Date().toISOString(), uploads });
    published = { key, at: Date.now() };
  }
  return {
    ...runner,
    async tick(): Promise<void> {
      await runner.tick();
      await publishReport().catch((error) => console.warn(`[publishing] uploads report not published: ${error instanceof Error ? error.message : String(error)}`));
    },
  };
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

/** The release numbers an upload on this computer holds (queued, running, done, or of unknown outcome): their package is taken. */
async function localHeldVideos(channelId: string): Promise<Set<string>> {
  return new Set((await listPublishingUploads({ channelId, limit: 5000 })).filter(holdsPackage).map((row) => row.video));
}

/** The release numbers another computer reports as uploading or uploaded, with that computer's name (ADR 0037 §4). */
async function peerUploadsOf(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>> {
  const peers = new Map<string, { host: string | null; uploaded: boolean }>();
  for (const report of await createPublishingUploadsShareCoreForProduction().listPeerReports().catch(() => [])) {
    for (const upload of report.uploads) {
      if (upload.channelId === channelId && !peers.has(upload.video)) peers.set(upload.video, { host: report.hostName, uploaded: upload.state === "uploaded" });
    }
  }
  return peers;
}

/**
 * BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md): the owner's own release package, made from a video folder's files
 * (Content → «Публикация» → «Новый пакет»). The package scan's reads; a package held by an upload here or on another computer is
 * never replaced (the approval's rule). Writes only `<folder>/Vn_release.json`, inside the workspace's real folder.
 */
export function createPackageComposerCore() {
  const { deps } = createPackageScanReads();
  return createPackageComposer({
    workspace: deps.workspace,
    validateWorkspace: deps.validateWorkspace,
    listDir: deps.listDir,
    resolveFile: deps.resolveFile,
    readText: deps.readText,
    readHead: deps.readHead,
    probeDuration: deps.probeDuration,
    channel: deps.channel,
    videos: deps.videos,
    async heldVideos(channelId) {
      return new Set([...(await localHeldVideos(channelId)), ...(await peerUploadsOf(channelId)).keys()]);
    },
    writeManifest: (workspace, folder, name, text) => writeVideoFolderFile(workspace, folder, name, text),
    join: deps.join,
  });
}
export type { ComposerFolder, PackageDraft } from "./package-composer";

/** BL-182 stage 2: the owner's approval of release-package uploads (queued here; the runner sends them). */
export function createUploadApprovalCore() {
  const scan = createPackageScanCore();
  const settings = createPublishingSettingsCore();
  return createUploadApproval({
    scan: (channelId) => scan.scan(channelId),
    settings: (channelId) => settings.read(channelId),
    liveVideos: (channelId) => localHeldVideos(channelId),
    peerUploads: (channelId) => peerUploadsOf(channelId),
    insertsToday: (now) => videosInsertCallsSince(startOfYoutubeQuotaDay(now)),
    async pending(now) {
      const rows = await listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 });
      let units = 0;
      for (const row of rows) {
        const settings = (() => {
          try {
            return JSON.parse(row.settingsJson) as { playlistId?: string | null };
          } catch {
            return {};
          }
        })();
        units += estimateUploadUnits({ playlist: Boolean(settings.playlistId), deferredPublishAt: !row.publishAtAtInsert && isDeferredPublishAt(row.publishAt, now) });
      }
      return { inserts: rows.filter((row) => row.videoId === null).length, units };
    },
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

/**
 * The owner looked in Studio after an `unknown_outcome` and found no video: the row stops holding its package, which can then be
 * approved again (re-check 1). Only such a row, and only on the owner's own action in the Web UI.
 */
export async function releaseUnknownOutcome(channelId: string, uploadId: string): Promise<boolean> {
  const row = await getPublishingUpload(uploadId);
  if (!row || row.channelId !== channelId || row.status !== "failed" || row.errorCode !== "unknown_outcome" || row.videoId !== null) return false;
  const done = await updatePublishingUpload(uploadId, "failed", { errorCode: UNKNOWN_OUTCOME_RELEASED, updatedAt: new Date() });
  if (done) await insertVideoEditAuditEvent({ channelId, videoId: `upload:${uploadId}`, eventType: "RESULT", detail: { event: "publishing.unknown_outcome_released", uploadId, video: row.video } });
  return done;
}
