import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createReleaseFolderRename } from "./release-folder-rename";
import { createReleaseRecode, type ReleaseRecodeDeps, type ReleaseRecodeJournal } from "./release-recode";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { releaseRecodeJournalDir, releaseRecodeJournalPath } from "@/lib/release-recode-journals";
import { lstat, mkdir, open, readdir, readFile, realpath, rename as renamePath, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createPackageMetadata } from "./package-metadata";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  createChannelPublishingSettingsCoreForProduction,
  createPublishingUploadsShareCoreForProduction,
  PUBLISHING_UPLOADS_REPORT_FORMAT,
} from "@/lib/sync-gateway";
import {
  clearPublishingG1Probe,
  getAutoPrivateUploadEnabled,
  getAutoPrivateUploadPausedChannels,
  setAutoPrivateUploadWaiting,
  getChannelExpectedLanguages,
  getLiveWritesEnabled,
  getDataApiReadsEnabled,
  listUploadRowsForTriedRule,
  listStoredChannels,
  getPublishingG1Probe,
  insertVideoEditAuditEvent,
  listVideoEditAuditEventsByVideo,
  claimPublishingUpload,
  getPublishingUpload,
  insertPublishingUploads,
  listPublishingUploads,
  listQuotaCalls,
  reorderQueuedPublishingUploads,
  rawSqlClient,
  rewritePublishingUploadPaths,
  recodeVideoRows,
  snapshotVideoRecodeRows,
  undoVideoRecodeRows,
  countActiveVideoJobs,
  listSocialPostJobs,
  listLiveStreamVideos,
  listLiveStreamSources,
  removeLocalVideoRowIfUnreferenced,
  savePublishingG1Probe,
  stopPublishingUploadBeforeYoutube,
  updatePublishingUpload,
  type StoredPublishingUpload,
  getVideoOrientations,
  rememberVideoOrientation,
} from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { DomainError, isDomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import { readOwnerReviewState, reviewGateOf, triedKeysOf } from "@/lib/package-reviews";
import { mediaKeyOf, type TriedPackages } from "./owner-review-gate";
import { createVideoDetailsCore } from "@/lib/video-details";
import { createVideoLocalizationsWriterCore } from "@/lib/shared-video-localizations";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { getQuotaLedgerSyncCore } from "@/lib/quota-ledger-sync";
import { nextYoutubeQuotaReset, startOfYoutubeQuotaDay } from "@/lib/youtube-quota";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, getVideoMetadataContext, getVideoUploadState, listPlaylistItemIdsByVideo, listUploadsPlaylistFirstPage } from "@/lib/youtube-read-gateway";
import { createWorkspaceExchangeFsForPublishing, isRealVideoFolder, resolveWorkspaceFileForPublishing, writeVideoFolderFile } from "./adapters/files";
import { createWorkspaceVideoFiles, videoNumberOfFolder, videosFolderSignature, writeUploadRecordFile } from "@/lib/workspace-videos";
import { reportVersionFor } from "@/lib/shared-video-code";
import { createPackageScan, isPackageThumbnailPath, VIDEOS_FOLDER, type PackageScanDeps, type ScannedPackage } from "./package-scan";
import { createPackageScanSignature } from "./scan-signature";
import { imageKindOf } from "./packages";
import { createPackageComposer } from "./package-composer";
import { authorizedOAuth, createPublishingFinishWrites, createPublishingYoutubeWrites, freshAccessToken } from "./adapters/youtube-writes";
import { ACTIVE_UPLOAD_STATUSES, createUploadRunner, isPlanChangeCancel, holdsPackage, holdsSlot, syntheticMediaOf, UNKNOWN_OUTCOME_RELEASED, type ApprovedPackage, type UploadRunnerDeps } from "./upload-runner";
import { createPlanSchedule, isVideoNotFound } from "./plan-schedule";
import type { PublishingSettings } from "./settings";
import { createUploadApproval } from "./upload-approval";
import { createAutoPrivateUpload, type AutoUploadWaiting, type SlotDecision } from "./auto-upload";
import { CANCELLED_BY_PRODUCER, createUploadQueueControl, queuePositions } from "./upload-queue-control";
import { estimateUploadUnits, isDeferredPublishAt } from "./publish-dates";
import type { G1ProbeRecord } from "./contracts";
import { agentUploadOf, createPublishingCalendarReads } from "./calendar-reads";
import type { CoveragePreRead, PublishingCoverageResult } from "@/lib/publishing-coverage";
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
/** `dailyCoverage` (BL-235): the shared daily coverage with the channel's zone, given by the app layer (`src/composition`). */
export function createPublishingCalendarCore(options: { dailyCoverage?: (channelId: string, days: number, preRead: CoveragePreRead) => Promise<PublishingCoverageResult> } = {}) {
  const store = createChannelVideoStoreAdapter();
  return createPublishingCalendarReads({
    ...(options.dailyCoverage ? { dailyCoverage: options.dailyCoverage } : {}),
    async listVideos(channelId) {
      return (await store.listVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        privacyStatus: video.privacyStatus,
        publishedAt: video.publishedAt,
        publishAt: video.publishAt,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        syncedAtMs: video.lastSyncedAt.getTime(),
        // BL-235: the language fields, so the daily coverage reuses these rows instead of reading them again.
        description: video.description,
        defaultLanguage: video.defaultLanguage,
        localizations: video.existingLocalizations,
      }));
    },
    getChannel: (channelId) => store.getChannel(channelId),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    clock: { now: () => new Date() },
    async packages(channelId, options) {
      const result = await createPackageScanCore().scan(channelId, options);
      if (result.status !== "ok") return { status: result.status === "no_workspace" ? "no_workspace" : "unavailable" };
      return {
        status: "ok",
        items: result.packages.map((p) => ({
          video: p.video,
          title: p.title,
          plannedPublishDate: p.plannedPublishDate,
          state: p.state,
          problems: p.problems.map((problem) => problem.code),
          warnings: (p.warnings ?? []).map((problem) => problem.code),
          videoId: p.youtube?.videoId ?? null,
          // BL-243: whether the uploaded video is still on the channel, as of the copy's last sync.
          existsOnChannel: p.existsOnChannel,
          checkedAt: p.checkedAt,
          removedAt: p.youtube?.removedAt ?? null,
        })),
      };
    },
    async uploads(channelId) {
      return (await listChannelUploads(channelId)).map((row) => agentUploadOf(row));
    },
  });
}

export type PublishingCalendarCore = ReturnType<typeof createPublishingCalendarCore>;

// ffprobe is looked up once per process once found (until then, on every check); a probed duration is kept per file and
// size (a finished video does not change).
const scanHolder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const FFMPEG_KEY = Symbol.for("ytom.publishing.ffmpeg");
const PROBE_CACHE_KEY = Symbol.for("ytom.publishing.probeCache");
const FRAME_CACHE_KEY = Symbol.for("ytom.publishing.frameCache");

/** BL-182 stage 2: the channel's release packages under `04 Videos/`, checked again (Content → «Публикация»). Read-only. */
export function createPackageScanCore() {
  const scan = createPackageScanReads();
  const files = createWorkspaceVideoFiles();
  /** A file under `04 Videos/` of the channel's workspace by the workspace rule, whose REAL path is inside the real `04 Videos/`. */
  async function packageFile(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null> {
    if (!relativePath.startsWith(`${VIDEOS_FOLDER}/`)) return null;
    const workspace = await scan.workspace(channelId);
    if (!workspace) return null;
    const file = await scan.resolveFile(workspace, relativePath);
    if (!file) return null;
    // The file's real path must be inside the real `04 Videos/`: a symlink there must not serve another workspace file (review).
    const videosRoot = await realpath(path.join(workspace, VIDEOS_FOLDER)).catch(() => null);
    return videosRoot && isPathInsideOrEqual(videosRoot, file.path) ? file : null;
  }
  return {
    /** BL-257 (ADR 0070 §6): a package's own file (its video or thumbnail) for the owner's review player; null when it is none. */
    resolvePackageFile: (channelId: string, relativePath: string) => packageFile(channelId, relativePath),
    scan: (channelId: string, options?: { checkedAt?: string | null; removedVideos?: Array<{ videoId: string; removedAt: string }> }) => scan.reads.scan(channelId, options),
    /**
     * A package's thumbnail for the preview: only an image under `04 Videos/` of the channel's workspace, reached through the
     * workspace rule, at most 10 MB; its type is read from its first bytes, never from its name. Null when it is none of that.
     */
    async readThumbnail(channelId: string, relativePath: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
      if (!isPackageThumbnailPath(relativePath)) return null;
      const file = await packageFile(channelId, relativePath);
      if (!file || file.bytes > 10 * 1024 * 1024) return null;
      const bytes = await files.readHead(file.path, file.bytes);
      const kind = imageKindOf(bytes);
      return kind === "other" ? null : { bytes, contentType: kind === "png" ? "image/png" : "image/jpeg" };
    },
  };
}

/**
 * BL-265 (ADR 0072 §1): the channel's owner-review state with the BL-263 recode aliases (V -> S) the video list knows, so a media
 * approval follows a recode without a copy. video-projects is read lazily (as the plan progress does); unreadable -- no aliases.
 */
export async function ownerReviewStateFor(channelId: string) {
  return readOwnerReviewState(channelId, {
    recodeAliases: async (id) => {
      const { createVideoProjectsServiceForProduction } = await import("@/lib/video-projects");
      return createVideoProjectsServiceForProduction().recodeAliasesOf(id);
    },
  });
}

/** BL-265 (ADR 0072 §6): package-reviews' tried keys in the publishing module's spelling. */
function triedPackagesOf(keys: { manifests: Set<string>; media: Array<{ video: string; videoSha256: string; sizeBytes: number }> }): TriedPackages {
  return { manifests: keys.manifests, media: new Set(keys.media.map((k) => mediaKeyOf(k.video, k.videoSha256, k.sizeBytes))) };
}


function createPackageScanReads() {
  const workspaces = createChannelWorkspacesCore();
  const files = createWorkspaceVideoFiles();
  const videoStore = createChannelVideoStoreAdapter();
  const probeCache = (scanHolder[PROBE_CACHE_KEY] ??= new Map<string, number | null>()) as Map<string, number | null>;
  const frameCache = (scanHolder[FRAME_CACHE_KEY] ??= new Map<string, { width: number; height: number } | null>()) as Map<string, { width: number; height: number } | null>;
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
      const probe = await probeMedia(tools, absolutePath).catch(() => null);
      probeCache.set(key, probe?.durationSeconds ?? null);
      // BL-259: the same ffprobe call gives the frame (no second run).
      // A phone's 90/270-degree flag shows the stored frame turned: its width and height swap on screen (review).
      const quarter = Math.abs(Math.round((probe?.video?.rotation ?? 0) / 90)) % 2 === 1;
      frameCache.set(key, probe?.video?.width && probe.video.height ? (quarter ? { width: probe.video.height, height: probe.video.width } : { width: probe.video.width, height: probe.video.height }) : null);
      return probe?.durationSeconds ?? null;
    },
    // BL-259 (owner msg 4397): the frame from the duration's ffprobe run (the scan probes the duration first).
    async probeFrame(absolutePath, bytes) {
      return frameCache.get(`${absolutePath}|${bytes}`) ?? null;
    },
    orientations: { get: (channelId) => getVideoOrientations(channelId), remember: (channelId, video, orientation) => rememberVideoOrientation(channelId, video, orientation) },
    async channel(channelId) {
      const baseline = await getChannelExpectedLanguages(channelId);
      return { channelId, defaultLanguage: baseline.defaultLanguage, defaultAudioLanguage: baseline.defaultAudioLanguage };
    },
    async videos(channelId) {
      return (await videoStore.listVideosByChannel(channelId)).map((video) => ({ videoId: video.videoId, title: video.title, description: video.description, privacyStatus: video.privacyStatus, publishAt: video.publishAt, publishedAt: video.publishedAt }));
    },
    // BL-243: the removed mark and the copy's age, so a deleted video is not read as uploaded.
    removedVideos: (channelId) => removedVideosOf(channelId),
    // BL-243 review: when the removed check last ran -- not lastSyncedAt, which also moves on syncs that skip it.
    async videosCheckedAt(channelId) {
      return (await videoStore.getChannel(channelId))?.removedCheckAt?.toISOString() ?? null;
    },
    join: (...parts) => path.join(...parts),
    clock: { now: () => new Date() },
    // BL-257 (ADR 0070 §2): the owner's review of the channel's final packages -- every consumer of the scan (the weekly plan, the
    // automatic upload, the Producer's queue add, the owner's upload approval) sees the same gate. No document: no gate.
    ownerReview: async (channelId) => reviewGateOf(await ownerReviewStateFor(channelId)),
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


/** Every row that holds its package: under way, or done / failed with a video (review B1) -- the other computer must refuse those too. */
async function ownUploadsForReport() {
  return (await listPublishingUploads({ limit: 500 }))
    .filter(holdsPackage)
    .map((row) => ({
      channelId: row.channelId,
      video: row.video,
      state: (ACTIVE_UPLOAD_STATUSES as readonly string[]).includes(row.status) ? (row.status as "queued" | "uploading" | "processing" | "finishing" | "paused") : ("uploaded" as const),
    }));
}

async function writeUploadsReport(uploads: Awaited<ReturnType<typeof ownUploadsForReport>>): Promise<void> {
  const device = await thisDevice();
  const deviceId = (await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath).ensureExists()).deviceId;
  const hostName = (device.hostname ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 64) || null;
  // BL-263 (plan §5): version 2 only when a row names an S code; a V-only report stays version 1 exactly as before.
  await createPublishingUploadsShareCoreForProduction().publishLocalReport({ format: PUBLISHING_UPLOADS_REPORT_FORMAT, version: reportVersionFor(uploads.map((u) => u.video)), deviceId, hostName, updatedAt: new Date().toISOString(), uploads });
}

/** BL-263: this computer's uploads report written now (after a recode moved rows from a V to an S code). */
export async function publishUploadsReportNow(): Promise<void> {
  await writeUploadsReport(await ownUploadsForReport());
}

/**
 * BL-182 stage 2 (ADR 0037): the background upload runner of this computer. Every write goes through the write gateway right after
 * the Live writes check; every read through the read gateway; the deferred publish time through video-details' own write path.
 */
export function createUploadRunnerCore(options: { slotDecisions?: (channelId: string) => Promise<Map<string, SlotDecision>>; bandwidth?: UploadRunnerDeps["bandwidth"] } = {}) {
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
    // BL-257 (review M1): the owner's package review now -- a queued row he no longer covers is cancelled before any byte.
    ownerReview: async (channelId) => reviewGateOf(await ownerReviewStateFor(channelId)),
    // BL-265 (ADR 0072 §4): a queued row's manifest read once (hash and text of the same bytes), and the scan's own checks of a
    // re-packaged one with fresh facts.
    async readManifest(channelId, manifestPath) {
      const file = await deps.files.resolve(channelId, manifestPath);
      if (!file || file.bytes > 1024 * 1024) return null;
      const bytes = await readFile(file.path);
      return { sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") };
    },
    async packageProblemsNow(channelId, manifestPath, manifestSha256) {
      const scanned = await createPackageScanReads().reads.scan(channelId);
      if (scanned.status !== "ok") return { problems: [{ code: scanned.status }] };
      const found = scanned.packages.find((p) => p.manifestPath === manifestPath);
      if (!found || found.manifestSha256 !== manifestSha256) return "changed";
      // An upload record next to it: the package is on YouTube already (from either computer) -- never sent again.
      if (found.youtube !== null) return { problems: [{ code: "youtube_record_exists" }] };
      return { problems: found.problems };
    },
    // Review #1 (BL-225): the plan's decision on a row's slot now, from the composition layer (absent: the row's own date stands).
    ...(options.slotDecisions
      ? { slotDecision: async (channelId: string, slotId: string) => (await options.slotDecisions!(channelId)).get(slotId) ?? null }
      : {}),
    // BL-225 stage 3 (AGENTS.md §F «Upload localizations», ADR 0051 §8): the shared video translations writer, named in the audit.
    async writeLocalizations({ channelId, videoId, localizations, expected, credentialRef }) {
      const result = await createVideoLocalizationsWriterCore("upload_localizations").apply({ credentialRef, channelId, videoId, localizations, expected });
      if ("sent" in result) return { verified: false, detail: `not sent (${result.reason})` };
      return result;
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
        await writeUploadRecordFile(await workspaceOf(channelId), relativePath, record);
      },
    },
    // BL-194 stage 3 (ADR 0041): the video's cost next to its package -- the video-costs module, loaded only here and only when used
    // (AGENTS.md §M: uploads never depend on it; a failure is a note).
    costFile: async (args) => {
      const { createVideoCostsServiceForProduction } = await import("@/lib/video-costs");
      await createVideoCostsServiceForProduction().writeCostFile(args);
    },
    audit: ({ channelId, videoId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: videoId ?? `upload:${String(detail.uploadId ?? "")}`, eventType: "RESULT", detail }),
    async syncChannel({ channelId, credentialRef }) {
      await createChannelSyncCore().syncChannel({ credentialRef, channelId });
    },
    device: () => thisDevice(),
    clock: { now: () => new Date() },
    nextQuotaReset: (now) => nextYoutubeQuotaReset(now),
    // BL-233 (FO-REQ-0047): the share of the uplink while live streams run here, plugged in by the app layer (absent: unlimited).
    ...(options.bandwidth ? { bandwidth: options.bandwidth } : {}),
    chunkBytes: 32 * 256 * 1024, // 8 MB
    sliceMs: 50_000,
    runnerId: `${hostname()}:${process.pid}:${randomUUID()}`,
  };
  const runner = createUploadRunner(deps);
  let published = { key: "", at: 0 };
  /** This computer's uploads under way, for the other computer (ADR 0037 §4); written when they change, refreshed every 5 minutes. */
  async function publishReport(): Promise<void> {
    const uploads = await ownUploadsForReport();
    const key = JSON.stringify(uploads);
    if (key === published.key && Date.now() - published.at < 5 * 60_000) return;
    await writeUploadsReport(uploads);
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
    isVideoFolder: (workspace, folder) => isRealVideoFolder(workspace, folder),
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
    async pending() {
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
        units += estimateUploadUnits({ playlist: Boolean(settings.playlistId), deferredPublishAt: !row.publishAtAtInsert && isDeferredPublishAt(row.publishAt) });
      }
      return { inserts: rows.filter((row) => row.videoId === null).length, units };
    },
    checkUnits: (units) => createQuotaGuardCore().checkUnits(units),
    // Review #5 (BL-225): the slots held by an upload here (queued, running, done, or with a video).
    // BL-243: a done row of a video deleted on YouTube holds no slot (its video NUMBER stays held: `liveVideos`).
    heldSlots: async (channelId) => {
      const [rows, removedList, channel] = await Promise.all([
        listPublishingUploads({ channelId, withSlot: true, limit: 5000 }),
        removedVideosOf(channelId).catch(() => []),
        createChannelVideoStoreAdapter().getChannel(channelId).catch(() => null),
      ]);
      const removed = new Set(removedList.map((video) => video.videoId));
      return new Set(rows.filter((row) => holdsSlot(row, removed, channel?.removedCheckAt ?? null)).map((row) => row.slotId as string));
    },
    insert: (rows) => insertPublishingUploads(rows),
    newId: () => randomUUID(),
    audit: ({ channelId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `upload:${String(detail.uploadId ?? "")}`, eventType: "RESULT", detail }),
    clock: { now: () => new Date() },
  });
}

const AUTO_HASH_CACHE_KEY = Symbol.for("ytom.publishing.autoUploadHashCache");
const AUTO_MISMATCH_LOG_KEY = Symbol.for("ytom.publishing.autoUploadMismatchLog");
const AUTO_WAITING_KEY = Symbol.for("ytom.publishing.autoUploadWaiting");

/**
 * BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md, ADR 0046): the automatic private upload of this computer, ticked by its own loop
 * (`src/instrumentation.ts`, AGENTS.md §M). Off (the default) a tick reads the switch only. On, it scans every connected channel's
 * packages, hashes a video only when its size matches, and queues through the approval's own checks; the runner uploads.
 */
export function createAutoPrivateUploadCore(options: { slotDecisions?: (channelId: string) => Promise<Map<string, SlotDecision>> } = {}) {
  const scan = createPackageScanCore();
  const approval = createUploadApprovalCore();
  const files = createPackageScanReads();
  const holder = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const hashCache = (holder[AUTO_HASH_CACHE_KEY] ??= new Map<string, string>()) as Map<string, string>;
  const loggedMismatches = (holder[AUTO_MISMATCH_LOG_KEY] ??= new Set<string>()) as Set<string>;
  return createAutoPrivateUpload({
    enabled: () => getAutoPrivateUploadEnabled(),
    async channels() {
      // Owner TG 2298: a channel paused for the automatic upload is skipped (its packages wait for the owner).
      const paused = new Set(await getAutoPrivateUploadPausedChannels());
      return (await listStoredChannels()).filter((channel) => !paused.has(channel.channelId)).map((channel) => ({ channelId: channel.channelId, userId: channel.connectedUserId }));
    },
    scan: (channelId) => scan.scan(channelId),
    liveVideos: (channelId) => localHeldVideos(channelId),
    peerUploads: (channelId) => peerUploadsOf(channelId),
    async triedHashes(channelId) {
      // BL-257 (ADR 0070 §5, AC-PR-11), BL-265 (ADR 0072 §6): the rows here keyed by their media (by the manifest for an older row);
      // a key the owner approved in package review whose rows were all cancelled before reaching YouTube, before that approval, is
      // not "tried" (the cancelled WWE V6-V11); any other row keeps it the owner's. The rule is package-reviews' own.
      // A row cancelled because the package moved to another slot (nothing sent) is no try (BL-265, plan §3.2).
      const rows = (await listUploadRowsForTriedRule(channelId)).filter((row) => !isPlanChangeCancel(row));
      return triedPackagesOf(triedKeysOf(await ownerReviewStateFor(channelId), rows));
    },
    async videoFile(channelId, relativePath) {
      const workspace = await files.workspace(channelId);
      if (!workspace) return null;
      const file = await files.resolveFile(workspace, relativePath);
      if (!file) return null;
      const info = await stat(file.path).catch(() => null);
      return info ? { path: file.path, bytes: file.bytes, mtimeMs: info.mtimeMs } : null;
    },
    hashFile: (absolutePath) => sha256OfFile(absolutePath),
    queue: (input) => approval.queueAutomatic(input),
    // BL-225 stage 3: the weekly plan's slots, given by the composition layer (absent: as before -- every package private, no date).
    ...(options.slotDecisions ? { slotDecisions: options.slotDecisions } : {}),
    logMismatch: ({ channelId, video, manifestSha256, expected, actual }) =>
      insertVideoEditAuditEvent({ channelId, videoId: `package:${video}`, eventType: "RESULT", detail: { event: "publishing.auto_upload_hash_mismatch", video, manifestSha256, expected, actual } }),
    logWaiting: (entry) =>
      insertVideoEditAuditEvent({
        channelId: entry.channelId,
        videoId: entry.kind === "package" ? `package:${entry.video}` : `channel:${entry.channelId}`,
        eventType: "RESULT",
        detail: { event: "publishing.upload_auto_waiting", ...entry },
      }),
    saveWaiting: (entries) => setAutoPrivateUploadWaiting(entries),
    waiting: (holder[AUTO_WAITING_KEY] ??= new Map()) as Map<string, AutoUploadWaiting>,
    hashCache,
    loggedMismatches,
    warn: (message) => console.warn(`[publishing] auto upload: ${message}`),
  });
}

/**
 * BL-243: the ids of the channel's videos the sync found removed on YouTube. An upload row of one of them holds no slot, is never
 * dated or undated by the plan, and says nothing of its slot's progress. Read-only (the local copy).
 */
export async function removedVideoIdsOf(channelId: string): Promise<Set<string>> {
  return new Set((await removedVideosOf(channelId)).map((video) => video.videoId));
}

/** BL-243: the channel's videos the sync found removed, with when (ISO) -- the package scan's own input, for a caller to pass in. */
export async function removedVideosOf(channelId: string): Promise<Array<{ videoId: string; removedAt: string }>> {
  return (await createChannelVideoStoreAdapter().listRemovedVideosByChannel(channelId)).map((video) => ({ videoId: video.videoId, removedAt: video.removedAt.toISOString() }));
}

/**
 * BL-270 (owner TG 4662/4665) and its review (findings 2, 3): the package-scan cache's fingerprints (`./scan-signature.ts`) over the
 * real ports -- `04 Videos/` by the walk's rules, the removed list, the copy's sync times, the scan's fields of the channel's videos
 * rows, and the files a kept scan resolved (followed through symlinks). Read-only; null when something cannot be read.
 */
function packageScanSignatures() {
  const files = createWorkspaceVideoFiles();
  const store = createChannelVideoStoreAdapter();
  return createPackageScanSignature({
    async workspace(channelId) {
      const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
      return workspace.configured && workspace.path ? workspace.path : null;
    },
    folderSignature: (workspace) =>
      videosFolderSignature({ listDir: (p) => files.listDir(p), statFile: (p) => files.statFile(p), join: (...parts) => path.join(...parts) }, workspace),
    removedVideos: (channelId) => removedVideosOf(channelId),
    async channelTimes(channelId) {
      const channel = await store.getChannel(channelId);
      return channel ? { lastSyncedAt: channel.lastSyncedAt?.getTime() ?? null, removedCheckAt: channel.removedCheckAt?.getTime() ?? null } : null;
    },
    videos: (channelId) => store.listVideoScanFields(channelId),
    async stat(absolutePath) {
      try {
        const [info, real] = await Promise.all([stat(absolutePath), realpath(absolutePath)]);
        return { size: info.size, mtimeMs: info.mtimeMs, realPath: real };
      } catch {
        return null;
      }
    },
    join: (...parts) => path.join(...parts),
  });
}

/** BL-270: the scan cache's fingerprint read before a scan (see `packageScanSignatures`). */
export function packageScanSignature(channelId: string): Promise<string | null> {
  return packageScanSignatures().signature(channelId);
}

/** BL-270 review (finding 3): the fingerprint of the files a kept scan resolved (see `packageScanSignatures`). */
export function packageScanFilesSignature(channelId: string, packages: readonly ScannedPackage[]): Promise<{ key: string; newestMtimeMs: number } | null> {
  return packageScanSignatures().filesSignature(channelId, packages);
}

/** The channel's uploads on this computer, newest first (the progress list in Content → «Публикация»). */
export async function listChannelUploads(channelId: string) {
  return listPublishingUploads({ channelId, limit: 100 });
}

/**
 * BL-258 (owner msg 4385): this computer's open uploads of every channel, each queued row with its place in the shared queue -- the
 * header's «Выполняется в фоне».
 */
export async function listActiveUploadsWithQueue() {
  const active = await listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 });
  const { positions } = queuePositions(active);
  return active.map((row) => ({ ...row, queuePosition: positions.get(row.id) ?? null }));
}

/**
 * BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md §6): the owner's list -- the channel's uploads with each queued row's place in the shared
 * queue of this computer (every channel) and the queue's length, so the ↑↓ arrows show what they change.
 */
export async function listChannelUploadsForOwner(channelId: string) {
  const [rows, active] = await Promise.all([listChannelUploads(channelId), listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 })]);
  const { positions, length } = queuePositions(active);
  return rows.map((row) => ({ ...row, queuePosition: positions.get(row.id) ?? null, queueLength: positions.has(row.id) ? length : null }));
}

/**
 * BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md, ADR 0059; owner msgs 3928/3930): control of this computer's upload queue. Reached only by
 * the Producer session's wiring (`src/lib/producer-mcp-endpoint/session-deps.ts`), the owner's move route and, through
 * `cancelUpload`, the owner's cancel/stop route (BL-244) -- never by a channel
 * worker or the factory endpoint (`no-agent-upload-tool.test.ts`). `slotDecisions` comes from the composition layer; `channelUser`
 * is the caller's own rule for "connected here" (absent: the channel's stored connected user).
 */
export function createUploadQueueControlCore(
  options: { slotDecisions?: (channelId: string) => Promise<Map<string, SlotDecision>>; channelUser?: (channelId: string) => Promise<string | null> } = {}
) {
  const scan = createPackageScanCore();
  const approval = createUploadApprovalCore();
  const files = createPackageScanReads();
  const audit = ({ channelId, uploadId, detail }: { channelId: string; uploadId: string; detail: Record<string, unknown> }) =>
    insertVideoEditAuditEvent({ channelId, videoId: `upload:${uploadId}`, eventType: "RESULT", detail });
  return createUploadQueueControl({
    listActive: () => listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 }),
    get: (uploadId) => getPublishingUpload(uploadId),
    reorder: (orderedIds) => reorderQueuedPublishingUploads(orderedIds),
    stop: (uploadId, fromStatus, set) => stopPublishingUploadBeforeYoutube(uploadId, fromStatus, set),
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
    autoSwitchOn: () => getAutoPrivateUploadEnabled(),
    async channelTitles() {
      return new Map((await listStoredChannels()).map((channel) => [channel.channelId, channel.title]));
    },
    channelUser: options.channelUser ?? (async (channelId) => (await listStoredChannels()).find((channel) => channel.channelId === channelId)?.connectedUserId ?? null),
    scan: (channelId) => scan.scan(channelId),
    liveVideos: (channelId) => localHeldVideos(channelId),
    peerUploads: (channelId) => peerUploadsOf(channelId),
    // One try per manifest version, as for the automatic upload -- except a version whose rows the Producer itself queued and
    // cancelled (review #4: a cancelled owner's or automatic row stays the owner's, so the Producer cannot replace his approval).
    async blockedHashes(channelId) {
      // The Producer's own cancels free their key (review #4); every other row blocks it -- by its media when it froze the mp4's
      // sha256, else by its manifest (BL-265, ADR 0072 §6).
      const all = (await listUploadRowsForTriedRule(channelId)).filter((row) => !isPlanChangeCancel(row));
      const producerCancelled = new Set(all.filter((row) => row.status === "cancelled" && row.errorCode === CANCELLED_BY_PRODUCER && row.queuedBy === "producer").map((row) => row.id));
      // PRD-REQ-0195 C (owner TG 2340 via the Producer, 2026-11-16): the same exception as the automatic upload (BL-257, ADR 0070
      // §5) -- a key the owner approved in package review whose rows here were all cancelled before reaching YouTube, before that
      // approval, may be queued by the Producer too (WWE V7: upload_already_tried). The rule is package-reviews' own.
      // As before BL-265: the exception is judged over EVERY row of the key (a Producer row made after the approval keeps it tried);
      // only then are the keys left that some row other than a Producer cancel holds.
      const state = await ownerReviewStateFor(channelId);
      const tried = triedPackagesOf(triedKeysOf(state, all));
      const held = triedPackagesOf(triedKeysOf({ ...state, required: false }, all.filter((row) => !producerCancelled.has(row.id))));
      return { manifests: new Set([...held.manifests].filter((k) => tried.manifests.has(k))), media: new Set([...held.media].filter((k) => tried.media.has(k))) };
    },
    ...(options.slotDecisions ? { slotDecisions: options.slotDecisions } : {}),
    async videoFile(channelId, relativePath) {
      const workspace = await files.workspace(channelId);
      if (!workspace) return null;
      const file = await files.resolveFile(workspace, relativePath);
      if (!file) return null;
      const info = await stat(file.path).catch(() => null);
      return info ? { path: file.path, bytes: file.bytes, mtimeMs: info.mtimeMs } : null;
    },
    hashFile: (absolutePath) => sha256OfFile(absolutePath),
    queue: (input) => approval.queueByProducer(input),
    logMismatch: ({ channelId, video, manifestSha256, expected, actual }) =>
      insertVideoEditAuditEvent({ channelId, videoId: `package:${video}`, eventType: "RESULT", detail: { event: "publishing.producer_upload_hash_mismatch", by: "producer", video, manifestSha256, expected, actual } }),
    audit,
    clock: { now: () => new Date() },
  });
}
export type { QueueActor, UploadQueueControl } from "./upload-queue-control";

/**
 * The owner cancels an upload that has not reached YouTube, or stops one being sent before its last chunk (BL-244, ADR 0064) --
 * through the queue control's one cancel, the same function as the Producer's. One whose video exists (or may exist: the last
 * chunk went) is refused (`upload_not_cancellable`): it is finished, and the owner deletes the video in Studio if needed.
 */
export async function cancelUpload(input: { channelId: string; uploadId: string }, userId: string) {
  return createUploadQueueControlCore().cancel(input, { kind: "owner", userId });
}
export type { UploadRunner, UploadSteps, ApprovedPackage } from "./upload-runner";
export type { AutoPrivateUpload, AutoUploadTickResult, AutoUploadWaiting } from "./auto-upload";

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

/**
 * BL-225 stage 3 (ADR 0051 §5, §7, §10; owner msg 3537): the weekly plan's changes to videos this computer uploaded for a slot -- a
 * veto removes the date, an approval or a re-approval with a new time sets it -- through video-details' write path (identity,
 * backup, Live writes right before the write, read-back). The slots' decisions come from the composition layer.
 */
export function createPlanScheduleCore(options: { slotDecisions: (channelId: string) => Promise<Map<string, SlotDecision>> }) {
  const videoDetails = createVideoDetailsCore();
  const parse = <T,>(text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };
  const credentialRefOf = (row: StoredPublishingUpload) => ({ userId: row.approvedBy });
  return createPlanSchedule({
    rows: async () => (await listPublishingUploads({ statuses: ["done"], withSlot: true, limit: 2000 })).filter((row) => row.videoId !== null),
    slotDecisions: options.slotDecisions,
    removedVideoIds: (channelId) => removedVideoIdsOf(channelId),
    async read(row) {
      try {
        const snapshot = await videoDetails.getSnapshot({ credentialRef: credentialRefOf(row), expectedChannelId: row.channelId, videoId: row.videoId as string });
        return { privacyStatus: snapshot.privacyStatus, publishAt: snapshot.publishAt };
      } catch (error) {
        // BL-243: YouTube's own "no such video" (the adapter names the id) -- deleted; any other failure stays a failure.
        if (isVideoNotFound(error, row.videoId as string)) return { privacyStatus: null, publishAt: null, missing: true };
        throw error;
      }
    },
    async write(row, publishAt) {
      const pkg = parse<ApprovedPackage>(row.packageJson) ?? ({} as ApprovedPackage);
      const settings = parse<PublishingSettings>(row.settingsJson);
      if (!settings) throw new Error("The upload's settings cannot be read.");
      await videoDetails.applyFieldsUpdate({
        credentialRef: credentialRefOf(row),
        expectedChannelId: row.channelId,
        videoId: row.videoId as string,
        // Status is replaced whole and YouTube never returns "AI use": it is sent again, as the upload sent it.
        patch: { privacyStatus: "private", publishAt, containsSyntheticMedia: syntheticMediaOf(pkg, settings) },
      });
    },
    update: (row, set) => updatePublishingUpload(row.id, "done", { ...set, updatedAt: new Date() }),
    audit: (row, detail) => insertVideoEditAuditEvent({ channelId: row.channelId, videoId: row.videoId ?? `upload:${row.id}`, eventType: "RESULT", detail }),
    clock: { now: () => new Date() },
    liveWritesEnabled: () => getLiveWritesEnabled(),
    dataReadsEnabled: () => getDataApiReadsEnabled(),
    nextQuotaReset: (now) => nextYoutubeQuotaReset(now),
  });
}
/**
 * BL-267 (ADR 0073 §5, plan §3.7): the YouTube side of an explicit move by the owner or the Producer -- this computer's newest finished
 * upload row of the video, then plan-schedule's one change function in explicit mode (video-details' write path: identity check,
 * backup, Live writes right before, read-back, audit). No second writer. Without such a row the video is not this computer's to move.
 */
export function createPlanMoveYoutubeCore(options: { slotDecisions: (channelId: string) => Promise<Map<string, SlotDecision>> }) {
  const schedule = createPlanScheduleCore(options);
  const rowOf = async (channelId: string, videoId: string) =>
    (await listPublishingUploads({ channelId, statuses: ["done"], limit: 2000 })).filter((row) => row.videoId === videoId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  return {
    async precheck(channelId: string, videoId: string) {
      const row = await rowOf(channelId, videoId);
      if (!row) return { outcome: "refused" as const, code: "publishing_plan_move_not_here", reason: "no finished upload of this video on this computer" };
      return schedule.explicitPrecheck(row);
    },
    /** Review #10: an upload of this slot or this video number still under way on this computer (queued … paused). */
    async uploadActive(channelId: string, slotId: string, video: string | null) {
      const active = await listPublishingUploads({ channelId, statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 });
      return active.some((row) => row.slotId === slotId || (video !== null && row.video === video));
    },
    async write(channelId: string, videoId: string, slotId: string, publishAtUtc: string, by: "owner" | "producer") {
      const row = await rowOf(channelId, videoId);
      if (!row) return { result: "refused", reason: "no finished upload of this video on this computer", publishAt: null };
      const result = await schedule.explicitMove(row, publishAtUtc, by, slotId);
      return { result: result.result, ...(result.reason ? { reason: result.reason } : {}), publishAt: result.publishAt };
    },
  };
}
export type { PlanSchedule } from "./plan-schedule";
export { checksPassed, decisionForRow, desiredDate } from "./plan-schedule";
export { approvalNamesUpload } from "./slot-decision";
export type { SlotPackageFingerprint } from "./slot-decision";
export type { SlotDecision } from "./auto-upload";

/**
 * BL-255 (ADR 0069 §3): true while this computer's upload of `videoId` has not yet run its own thumbnail step -- an active row
 * with that video id and no `steps.thumbnail` (a damaged `steps_json` counts as pending: fail closed). The thumbnail writer refuses
 * then, since the runner would put the package's file over the new one.
 */
export async function isUploadThumbnailStepPending(channelId: string, videoId: string): Promise<boolean> {
  return thumbnailStepPendingIn(await listPublishingUploads({ channelId, statuses: ACTIVE_UPLOAD_STATUSES, limit: 500 }), videoId);
}

/**
 * The rule of `isUploadThumbnailStepPending` on given rows: an active row (queued / uploading / processing / finishing / paused) of
 * that video id without `steps.thumbnail`; a damaged `steps_json` counts as pending. A finished, failed or cancelled row is never
 * resumed into its finishing steps (a new upload is a new row), so it is not pending.
 */
export function thumbnailStepPendingIn(rows: ReadonlyArray<Pick<StoredPublishingUpload, "status" | "videoId" | "stepsJson">>, videoId: string): boolean {
  return rows.some((row) => {
    if (row.videoId !== videoId || !(ACTIVE_UPLOAD_STATUSES as readonly string[]).includes(row.status)) return false;
    try {
      const steps = JSON.parse(row.stepsJson) as { thumbnail?: unknown } | null;
      return !steps || typeof steps !== "object" || steps.thumbnail === undefined;
    } catch {
      return true;
    }
  });
}

export type ThumbnailCandidateFolder = { folder: string; video: string | null; images: string[]; own: boolean };

/**
 * BL-255 (ADR 0069 §2): the images a thumbnail replace can choose from -- first the folders of this video's own uploads here
 * (`dirname(manifest_path)`, kept when the local mp4 was cleaned up), then the newest other release folders (at most 8). Only
 * direct .jpg/.jpeg/.png files under `04 Videos/`; every path is checked again when it is used (`readThumbnail`).
 */
export async function listThumbnailCandidates(channelId: string, videoId: string, videoNumber: string | null = null): Promise<ThumbnailCandidateFolder[]> {
  const { deps } = createPackageScanReads();
  const workspace = await deps.workspace(channelId);
  if (!workspace) return [];
  const imagesOf = async (folder: string) =>
    (await deps.listDir(deps.join(workspace, folder)))
      .filter((entry) => entry.kind === "file" && isPackageThumbnailPath(`${folder}/${entry.name}`))
      .map((entry) => `${folder}/${entry.name}`)
      .sort();
  const rows = await listPublishingUploads({ channelId, limit: 500 });
  const ownFolders = [...new Set(rows.filter((row) => row.videoId === videoId).map((row) => row.manifestPath.slice(0, Math.max(0, row.manifestPath.lastIndexOf("/")))))].filter((folder) =>
    folder.startsWith(`${VIDEOS_FOLDER}/`)
  );
  const result: ThumbnailCandidateFolder[] = [];
  for (const folder of ownFolders) result.push({ folder, video: videoNumberOfFolder(folder.split("/").at(-1) ?? ""), images: await imagesOf(folder), own: true });
  const others = await createPackageComposerCore()
    .listFolders(channelId)
    .catch(() => []);
  // The folders named after this video's number (`MMDD Vn`, the number the caller knows) count as its own too, first.
  const rest = others.filter((entry) => !ownFolders.includes(entry.folder));
  const byNumber = videoNumber ? rest.filter((entry) => entry.video === videoNumber) : [];
  for (const entry of [...byNumber, ...rest.filter((entry) => !byNumber.includes(entry)).slice(0, 8)]) {
    result.push({ folder: entry.folder, video: entry.video, images: entry.files.images.map((name) => `${entry.folder}/${name}`).filter(isPackageThumbnailPath).sort(), own: byNumber.includes(entry) });
  }
  return result;
}

/**
 * BL-255 (owner msg 4396): a thumbnail the thumbnail writer set later -- and read back (custom thumbnail, the image changed) -- is
 * the upload's thumbnail step done: every row of that video here whose `steps.thumbnail` is "failed" records "set" (with a note),
 * so the weekly plan may give the video its date (`checksPassed`). Nothing else of the row changes; a row that changed meanwhile is
 * left (compare-and-set on its status). Returns how many rows were marked.
 */
export async function markUploadThumbnailSetLater(channelId: string, videoId: string, at: Date): Promise<number> {
  let marked = 0;
  for (const row of await listPublishingUploads({ channelId, limit: 500 })) {
    if (row.videoId !== videoId) continue;
    let steps: Record<string, unknown>;
    try {
      steps = JSON.parse(row.stepsJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!steps || typeof steps !== "object" || steps.thumbnail !== "failed") continue;
    const notes = Array.isArray(steps.notes) ? [...(steps.notes as unknown[])] : [];
    notes.push(`thumbnail: set later by the thumbnail writer at ${at.toISOString()}`);
    if (await updatePublishingUpload(row.id, row.status, { stepsJson: JSON.stringify({ ...steps, thumbnail: "set", notes }), updatedAt: at })) marked++;
  }
  return marked;
}

/**
 * BL-261 (owner TG 3521 via the Factory Operator): rename one release package's folder under `04 Videos/` and rewrite this
 * computer's upload rows that name it. `invalidate`: the caller's package caches (the weekly plan's, composition) -- this module
 * never imports them.
 */
export function createReleaseFolderRenameCore(options: { invalidate?: (channelId: string) => void } = {}) {
  const scan = createPackageScanCore();
  const reads = createPackageScanReads();
  return createReleaseFolderRename({
    workspace: (channelId) => reads.workspace(channelId),
    scan: (channelId) => scan.scan(channelId),
    uploads: (channelId) => listPublishingUploads({ channelId, limit: 5000 }),
    peerUploads: (channelId) => peerUploadsOf(channelId),
    async socialBusy(channelId, video) {
      return (await listSocialPostJobs(channelId)).some((job) => job.video === video && (job.status === "uploading" || job.status === "processing"));
    },
    async livePaths(channelId) {
      const [videos, sources] = await Promise.all([listLiveStreamVideos(channelId), listLiveStreamSources(channelId)]);
      return [...videos, ...sources].map((row) => row.originalPath).filter((p): p is string => typeof p === "string");
    },
    now: () => new Date(),
    exists: (absolutePath) => lstat(absolutePath).then(() => true, () => false),
    async isRealFolder(workspace, relativeFolder) {
      const absolute = path.join(workspace, ...relativeFolder.split("/"));
      const info = await lstat(absolute).catch(() => null);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
      const [root, real] = await Promise.all([realpath(path.join(workspace, VIDEOS_FOLDER)).catch(() => null), realpath(absolute).catch(() => null)]);
      return root !== null && real !== null && real !== root && isPathInsideOrEqual(root, real);
    },
    rename: (from, to) => renamePath(from, to),
    rewriteUploads: (updates) => rewritePublishingUploadPaths(updates),
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
    audit: ({ channelId, video, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `release-folder:${video}`, eventType: "RESULT", detail }),
    invalidate: (channelId) => options.invalidate?.(channelId),
    join: (...parts) => path.join(...parts),
  });
}
export { folderNameProblem, rewritePaths, type ReleaseFolderRenameInput, type ReleaseFolderRenameResult } from "./release-folder-rename";

/**
 * BL-263 (SHORT_VIDEO_CODE_PLAN.md §6, ADR 0071 §4): the one-shot recode of a WWE Short's package from its V code to its S code, with
 * this module's reads and file system and the shared persistence layer's rows. Never a YouTube call. What other modules own -- the
 * video list, the owner's approvals, the storyboards, the other computers' rows, the other reports -- comes from the composition layer.
 */
export function createReleaseRecodeCore(options: {
  videoList: ReleaseRecodeDeps["videoList"];
  approvals: ReleaseRecodeDeps["approvals"];
  carryReviewDecision: ReleaseRecodeDeps["carryReviewDecision"];
  peerLinks: ReleaseRecodeDeps["peerLinks"];
  storyboards: ReleaseRecodeDeps["storyboards"];
  /** The reservations and costs reports written now (the uploads report is this module's own). */
  publishOtherReports(): Promise<void>;
  invalidate?: (channelId: string) => void;
}) {
  const scan = createPackageScanCore();
  const reads = createPackageScanReads();
  const appDataDir = getProductionAppPaths().appDataDir;
  return createReleaseRecode({
    workspace: (channelId) => reads.workspace(channelId),
    scan: (channelId) => scan.scan(channelId),
    uploads: (channelId) => listPublishingUploads({ channelId, limit: 5000 }),
    peerUploads: (channelId) => peerUploadsOf(channelId),
    async socialBusy(channelId, video) {
      return (await listSocialPostJobs(channelId)).some((job) => job.video === video && (job.status === "uploading" || job.status === "processing"));
    },
    async livePaths(channelId) {
      const [videos, sources] = await Promise.all([listLiveStreamVideos(channelId), listLiveStreamSources(channelId)]);
      return [...videos, ...sources].map((row) => row.originalPath).filter((p): p is string => typeof p === "string");
    },
    activeJobs: (channelId, video) => countActiveVideoJobs(channelId, video),
    videoList: options.videoList,
    approvals: options.approvals,
    carryReviewDecision: options.carryReviewDecision,
    peerLinks: options.peerLinks,
    async listFolder(absolutePath) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: e.isSymbolicLink() ? ("other" as const) : e.isDirectory() ? ("dir" as const) : e.isFile() ? ("file" as const) : ("other" as const) }));
    },
    readText: (absolutePath) => readFile(absolutePath, "utf8"),
    writeText: (absolutePath, text) => writeFileAtomic(absolutePath, text),
    exists: (absolutePath) => lstat(absolutePath).then(() => true, () => false),
    async isRealFolder(workspace, relativeFolder) {
      const absolute = path.join(workspace, ...relativeFolder.split("/"));
      const info = await lstat(absolute).catch(() => null);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) return false;
      const [root, real] = await Promise.all([realpath(path.join(workspace, VIDEOS_FOLDER)).catch(() => null), realpath(absolute).catch(() => null)]);
      return root !== null && real !== null && real !== root && isPathInsideOrEqual(root, real);
    },
    rename: (from, to) => renamePath(from, to),
    rows: {
      snapshot: (channelId, from, to, uploadIds) => snapshotVideoRecodeRows(channelId, from, to, uploadIds),
      recode: (snapshot, plan) => recodeVideoRows(snapshot, plan),
      undo: (snapshot, plan) => undoVideoRecodeRows(snapshot, plan),
    },
    storyboards: options.storyboards,
    journal: {
      pathFor: (channelId, video, at) => releaseRecodeJournalPath(appDataDir, channelId, video, at),
      async write(file, journal) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, JSON.stringify(journal, null, 2));
      },
      async list(channelId) {
        const dir = releaseRecodeJournalDir(appDataDir, channelId);
        const names = await readdir(dir).catch(() => [] as string[]);
        return names.filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n));
      },
      read: async (file) => JSON.parse(await readFile(file, "utf8")) as ReleaseRecodeJournal,
      remove: (file) => unlink(file),
    },
    async publishReports() {
      await Promise.allSettled([publishUploadsReportNow(), options.publishOtherReports()]);
    },
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
    audit: ({ channelId, video, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `release-recode:${video}`, eventType: "RESULT", detail }),
    invalidate: (channelId) => options.invalidate?.(channelId),
    now: () => new Date(),
    join: (...parts) => path.join(...parts),
  });
}
export { renamedForCode, rewriteManifest, type ReleaseRecodeInput, type ReleaseRecodeResult, type RecodeVideoList } from "./release-recode";

/**
 * BL-265 (ADR 0072 §5, AGENTS.md §F «Package metadata after upload»): the packaging fix of an uploaded video -- the owner's routes and
 * the Producer's tool, one service. The write is video-details' own (`applyFieldsUpdate`); this wires the package scan, this
 * computer's upload rows and audit, the device gate and publishing's own localization read.
 */
export function createPackageMetadataCore() {
  const scan = createPackageScanCore();
  const settings = createPublishingSettingsCore();
  const videoDetails = createVideoDetailsCore();
  const resolved = (userId: string, scopes: readonly string[]) => resolveGoogleCredentials({ credentialRef: { userId }, requiredScopes: scopes });
  return createPackageMetadata({
    async findPackage(channelId, video) {
      const result = await scan.scan(channelId);
      if (result.status !== "ok") return result.status;
      const named = result.packages.filter((p) => p.video === video && p.pkg && p.manifestSha256);
      if (named.length === 0) return "not_found";
      if (named.length > 1) return "ambiguous";
      const p = named[0];
      return { pkg: p.pkg!, manifestSha256: p.manifestSha256!, manifestPath: p.manifestPath, folder: p.folder, videoId: p.youtube?.videoId ?? null, thumbnailPath: p.thumbnailPath };
    },
    channelTags: async (channelId) => (await settings.read(channelId)).settings.channelTags ?? [],
    async uploadRows(channelId, video) {
      return (await listPublishingUploads({ channelId, limit: 5000 })).filter((row) => row.video === video).map((row) => ({ status: row.status, videoId: row.videoId, packageJson: row.packageJson, finishedAt: row.finishedAt }));
    },
    async lastApplied(channelId, videoId) {
      const events = (await listVideoEditAuditEventsByVideo(videoId)).filter((e) => e.channelId === channelId && e.eventType === "VERIFICATION");
      for (const event of events.reverse()) {
        const detail = event.detail as { source?: unknown; verified?: unknown; afterTexts?: { title?: unknown; description?: unknown; tags?: unknown } };
        const after = detail?.afterTexts;
        if (detail?.source === "package_metadata" && after && typeof after === "object") {
          // Per field; null (or anything malformed) is "unknown" -- a difference there is a conflict (review fix 1).
          return {
            title: typeof after.title === "string" ? after.title : null,
            description: typeof after.description === "string" ? after.description : null,
            tags: Array.isArray(after.tags) ? after.tags.filter((t): t is string => typeof t === "string") : null,
          };
        }
      }
      return null;
    },
    async lastThumbnailSha256(channelId, videoId) {
      const events = (await listVideoEditAuditEventsByVideo(videoId)).filter((e) => e.channelId === channelId && e.eventType === "RESULT");
      for (const event of events.reverse()) {
        const detail = event.detail as { event?: unknown; sha256?: unknown };
        if (detail?.event === "video_thumbnails.replaced" && typeof detail.sha256 === "string") return detail.sha256;
      }
      return null;
    },
    async fileSha256(channelId, relativePath) {
      const file = await scan.resolvePackageFile(channelId, relativePath);
      return file ? sha256OfFile(file.path) : null;
    },
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    async credentialRef(channelId, actor) {
      if (actor.kind === "owner") return { userId: actor.userId };
      const channel = (await listStoredChannels()).find((c) => c.channelId === channelId);
      if (!channel?.connectedUserId) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "This channel has no connected Google account on this computer.", details: { channelId } });
      return { userId: channel.connectedUserId };
    },
    async snapshot({ credentialRef, channelId, videoId }) {
      try {
        return await videoDetails.getSnapshot({ credentialRef, expectedChannelId: channelId, videoId });
      } catch (error) {
        // Only YouTube's own "no such video" is a missing video; any other failure is reported as it is.
        if (isDomainError(error) && error.code === "not_found" && (error.details as { reason?: unknown } | undefined)?.reason === "no_item") return "not_found";
        throw error;
      }
    },
    async localizationLanguages({ credentialRef, videoId }) {
      try {
        const youtube = await createYoutubeClient(authorizedOAuth(await resolved(credentialRef.userId, [YOUTUBE_READ_SCOPE])));
        const context = await getVideoMetadataContext(youtube, videoId);
        return context ? Object.keys(context.localizations).sort() : null;
      } catch {
        return null;
      }
    },
    applyFields: (args) => videoDetails.applyFieldsUpdate(args),
    audit: ({ channelId, videoId, eventType, detail }) => insertVideoEditAuditEvent({ channelId, videoId, eventType, detail }),
  });
}
export type { PackageMetadataActor, PackageMetadataApplyResult, PackageMetadataPreview } from "./package-metadata";
