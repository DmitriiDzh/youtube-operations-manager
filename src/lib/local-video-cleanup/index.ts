import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { YOUTUBE_READ_SCOPE, createGoogleOAuthClient } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLocalVideoCleanupSettingsJson,
  insertLocalVideoCleanupLog,
  listAllLiveStreamVideoRefs,
  listLocalVideoCleanupLog,
  listLocalVideoCleanupLoggedUploadIds,
  listPublishingUploads,
  listPublishingUploadsForCleanup,
  listStoredChannels,
  setLocalVideoCleanupSettingsJson,
  sumLocalVideoCleanupFreed,
  type StoredPublishingUpload,
} from "@/lib/db";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createExchangeFs, resolveFromYtmDir } from "@/lib/workspace-exchange";
import { createYoutubeClient, getVideosCleanupState } from "@/lib/youtube-read-gateway";
import { inspectReleaseFile, sha256OfFile, unlinkReleaseVideo, writeTombstone } from "./adapters/fs";
import type { CleanupLogEntry } from "./contracts";
import { createLocalVideoCleanup, type CleanupUpload, type LocalVideoCleanup } from "./services";

// BL-238 (FO-REQ-0051, ADR 0058): the local video cleanup wired to this computer -- its upload rows and live rotations (read through
// db.ts, never through the publishing or live-streams modules: AGENTS.md §M), the channel workspaces, the read gateway, ffprobe.

/** Upload rows that may still read their file (the publishing module's own active statuses). */
const ACTIVE_UPLOAD_STATUSES = ["queued", "uploading", "processing", "finishing", "paused"] as const;
const CSV_FILE = "cleanup-log.csv";
const CSV_HEADER = "at,channelId,video,videoId,action,reason,bytes,path\n";

const csvField = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function uploadOf(row: StoredPublishingUpload): CleanupUpload | null {
  let pkg: { videoFile?: unknown; videoSha256?: unknown };
  try {
    pkg = JSON.parse(row.packageJson) as typeof pkg;
  } catch {
    return null;
  }
  if (typeof pkg.videoFile !== "string") return null;
  return {
    id: row.id,
    channelId: row.channelId,
    approvedBy: row.approvedBy,
    video: row.video,
    videoFile: pkg.videoFile,
    videoId: row.videoId,
    storedBytes: row.storedBytes,
    totalBytes: row.totalBytes,
    errorCode: row.errorCode,
    finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
    sha256: typeof pkg.videoSha256 === "string" && /^[0-9a-f]{64}$/i.test(pkg.videoSha256) ? pkg.videoSha256 : null,
  };
}

const holder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const CORE_KEY = Symbol.for("youtube-operations-manager.local-video-cleanup");
const FFMPEG_KEY = Symbol.for("youtube-operations-manager.local-video-cleanup.ffmpeg");

/** One instance per process (the routes and the server's loop are separate bundles; the waits live in it). */
export function getLocalVideoCleanupCore(): LocalVideoCleanup {
  return (holder[CORE_KEY] ??= createLocalVideoCleanupCore()) as LocalVideoCleanup;
}

function createLocalVideoCleanupCore(): LocalVideoCleanup {
  const logger = createDefaultLogger();
  const workspaces = createChannelWorkspacesCore();
  const ffmpeg = async () => {
    const found = await ((holder[FFMPEG_KEY] ??= detectFfmpeg()) as Promise<FfmpegTools | null>);
    if (!found) holder[FFMPEG_KEY] = undefined;
    return found;
  };
  return createLocalVideoCleanup({
    getSettingsJson: () => getLocalVideoCleanupSettingsJson(),
    setSettingsJson: (json) => setLocalVideoCleanupSettingsJson(json),
    channelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
    async doneUploads(channelId, since) {
      const rows = await listPublishingUploadsForCleanup(channelId, new Date(since));
      return rows.map(uploadOf).filter((u): u is CleanupUpload => u !== null);
    },
    async activeUploadFiles() {
      const rows = await listPublishingUploads({ statuses: ACTIVE_UPLOAD_STATUSES, limit: 1000 });
      return new Set(rows.map(uploadOf).flatMap((u) => (u ? [u.videoFile] : [])));
    },
    liveRotation: () => listAllLiveStreamVideoRefs(),
    async workspace(channelId) {
      const workspace = await workspaces.getWorkspace({ channelId });
      if (!workspace.configured) return null;
      const valid = await validateOperatorDirectoryPath(workspace.path);
      return valid.ok ? workspace.path : null;
    },
    async readYoutube({ approvedBy, videoIds }) {
      const credentials = (await resolveGoogleCredentials({ credentialRef: { userId: approvedBy }, requiredScopes: [YOUTUBE_READ_SCOPE] })) as ResolvedCredentials;
      const oauth2 = createGoogleOAuthClient();
      oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
      return getVideosCleanupState(await createYoutubeClient(oauth2), videoIds);
    },
    fs: {
      inspect: (workspace, relativePath) => inspectReleaseFile(workspace, relativePath),
      sha256: (absolutePath) => sha256OfFile(absolutePath),
      async probeDuration(absolutePath) {
        const tools = await ffmpeg();
        if (!tools) return "no_ffprobe";
        return probeMedia(tools, absolutePath).then((probe) => probe.durationSeconds ?? null);
      },
      writeTombstone: (absolutePath, tombstone) => writeTombstone(absolutePath, tombstone),
      unlink: (args) => unlinkReleaseVideo(args),
      async appendCsv(workspace, entry: CleanupLogEntry) {
        const dir = await resolveFromYtmDir({ workspace, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason) => new Error(reason) });
        const file = path.join(dir, CSV_FILE);
        const existing = await lstat(file).catch(() => null);
        if (existing && !existing.isFile()) throw new Error(`${CSV_FILE} is not a plain file`);
        const line = [new Date(entry.at).toISOString(), entry.channelId, entry.video, entry.videoId, entry.action, entry.reason, entry.bytes, entry.path].map(csvField).join(",") + "\n";
        const handle = await open(file, "a");
        try {
          await handle.appendFile(existing ? line : CSV_HEADER + line, "utf8");
        } finally {
          await handle.close();
        }
      },
    },
    log: {
      async insert(entry) {
        return insertLocalVideoCleanupLog({ ...entry, at: new Date(entry.at) });
      },
      loggedUploadIds: (channelId) => listLocalVideoCleanupLoggedUploadIds(channelId),
      async list(channelId, limit) {
        return (await listLocalVideoCleanupLog(channelId, limit)).map((row) => ({ ...row, at: row.at.getTime() }));
      },
      freed: (channelId) => sumLocalVideoCleanupFreed(channelId),
    },
    newId: () => randomUUID(),
    clock: () => Date.now(),
    note: (event, context) => logger.info({ event, context }),
  });
}

export * from "./contracts";
export { isAllowedReleaseVideo, channelNameOfFolder } from "./allowlist";
export type { LocalVideoCleanup } from "./services";
