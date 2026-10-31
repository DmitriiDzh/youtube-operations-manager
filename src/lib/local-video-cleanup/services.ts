// BL-238 (FO-REQ-0051, ADR 0058): the sweep. For each channel whose switch is on (this computer), every upload of this computer
// that finished after the switch went on and has no log entry yet is checked fresh -- locally first, then on YouTube (one read
// per 50 videos), then its content -- and its mp4 is deleted behind a durable tombstone, or refused (logged once), or left to
// wait. One sweep at a time; one file at a time.

import { channelNameOfFolder } from "./allowlist";
import {
  CLEANUP_DELETED_BY,
  CLEANUP_READ_BATCH,
  TOMBSTONE_SCHEMA,
  type CleanupChannelSetting,
  type CleanupChannelView,
  type CleanupDecision,
  type CleanupLogEntry,
  type CleanupSettings,
  type CleanupWaitReason,
  type VideoTombstone,
} from "./contracts";
import {
  decideLocally,
  decideOnContent,
  decideOnYoutube,
  isoDurationSeconds,
  type CleanupUploadFacts,
  type LocalFileFacts,
  type YoutubeVideoFacts,
} from "./decide";

export type CleanupUpload = CleanupUploadFacts & {
  id: string;
  channelId: string;
  approvedBy: string;
  finishedAt: number | null;
  /** The package's SHA-256 of the video (automatic uploads freeze it), else null. */
  sha256: string | null;
};

export type CleanupInspected = LocalFileFacts & {
  absolutePath?: string;
  identity?: { dev: number; ino: number };
};

export type CleanupYoutubeState = {
  uploadStatus: string | null;
  processingStatus: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  fileSize: number | null;
  duration: string | null;
};

export type LocalVideoCleanupDeps = {
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  /** This computer's finished uploads of the channel (status `done`) that finished at or after `since` and have no log entry yet. */
  doneUploads(channelId: string, since: number): Promise<CleanupUpload[]>;
  /** The relative video paths of this computer's uploads still running (any channel). */
  activeUploadFiles(): Promise<Set<string>>;
  /** Every live rotation entry of this computer: the video and its original file. */
  liveRotation(): Promise<Array<{ videoId: string; originalPath: string | null }>>;
  /** The channel's workspace folder on this computer; null when none is set. */
  workspace(channelId: string): Promise<string | null>;
  /** YouTube's state of up to 50 of the channel's videos (absent = not returned); throws when it cannot be read now. */
  readYoutube(args: { channelId: string; approvedBy: string; videoIds: string[] }): Promise<Map<string, CleanupYoutubeState>>;
  fs: {
    inspect(workspace: string, relativePath: string): Promise<CleanupInspected>;
    sha256(absolutePath: string): Promise<string>;
    probeDuration(absolutePath: string): Promise<number | null | "no_ffprobe">;
    writeTombstone(absolutePath: string, tombstone: VideoTombstone): Promise<void>;
    unlink(args: {
      workspace: string;
      relativePath: string;
      video: string;
      channelName: string;
      expected: { dev: number; ino: number; bytes: number; videoId: string };
    }): Promise<void>;
    /** One line of `99 Data Exchange/From YTM/cleanup-log.csv` (the folder is created); a failure is the caller's note only. */
    appendCsv(workspace: string, entry: CleanupLogEntry): Promise<void>;
  };
  log: {
    insert(entry: CleanupLogEntry): Promise<boolean>;
    loggedUploadIds(channelId: string): Promise<Set<string>>;
    list(channelId: string, limit: number): Promise<CleanupLogEntry[]>;
    freed(channelId: string): Promise<{ bytes: number; count: number }>;
  };
  newId(): string;
  clock(): number;
  note(event: string, context: Record<string, unknown>): void;
};

export function parseCleanupSettings(json: string | null): CleanupSettings {
  try {
    const value = JSON.parse(json ?? "{}") as {
      channels?: Record<string, Partial<CleanupChannelSetting>>;
    };
    const channels: Record<string, CleanupChannelSetting> = {};
    for (const [channelId, raw] of Object.entries(value.channels ?? {})) {
      const enabled = raw?.enabled === true;
      const enabledAt = typeof raw?.enabledAt === "number" && Number.isFinite(raw.enabledAt) ? raw.enabledAt : null;
      channels[channelId] = {
        enabled: enabled && enabledAt !== null,
        enabledAt: enabled ? enabledAt : null,
      };
    }
    return { channels };
  } catch {
    return { channels: {} };
  }
}

type Waiting = { video: string; reason: CleanupWaitReason; checkedAt: number };

export function createLocalVideoCleanup(deps: LocalVideoCleanupDeps) {
  let running: Promise<void> | null = null;
  /** Review #5: switch changes one after another (the settings are one JSON for every channel). */
  let switching: Promise<unknown> = Promise.resolve();
  /** The last wait of each upload (this process only: a restart checks again anyway). */
  const waiting = new Map<string, Map<string, Waiting>>();

  const settings = async () => parseCleanupSettings(await deps.getSettingsJson());

  async function record(
    workspace: string | null,
    upload: CleanupUpload,
    action: "deleted" | "refused",
    reason: string | null,
    bytes: number | null
  ): Promise<void> {
    const entry: CleanupLogEntry = {
      id: deps.newId(),
      channelId: upload.channelId,
      uploadId: upload.id,
      video: upload.video,
      path: upload.videoFile,
      bytes,
      videoId: upload.videoId,
      action,
      reason,
      at: deps.clock(),
    };
    if (!(await deps.log.insert(entry))) return;
    deps.note(`local_video_cleanup.${action}`, {
      channelId: upload.channelId,
      video: upload.video,
      videoId: upload.videoId,
      path: upload.videoFile,
      bytes,
      reason,
    });
    if (workspace)
      await deps.fs.appendCsv(workspace, entry).catch((error: unknown) =>
        deps.note("local_video_cleanup.csv_failed", {
          channelId: upload.channelId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
  }

  function setWaiting(upload: CleanupUpload, reason: CleanupWaitReason): void {
    const forChannel = waiting.get(upload.channelId) ?? new Map<string, Waiting>();
    forChannel.set(upload.id, {
      video: upload.video,
      reason,
      checkedAt: deps.clock(),
    });
    waiting.set(upload.channelId, forChannel);
  }

  /** Applies a decision that is not `delete`. True when the upload is settled (logged or done). */
  async function settle(workspace: string | null, upload: CleanupUpload, decision: CleanupDecision, bytes: number | null): Promise<void> {
    if (decision.action === "wait") setWaiting(upload, decision.reason);
    else {
      waiting.get(upload.channelId)?.delete(upload.id);
      if (decision.action === "refuse") await record(workspace, upload, "refused", decision.reason, bytes);
      // Review #2: the delete went through before a crash cut its log entry -- logged now, so it counts and is not checked again.
      if (decision.action === "recovered") await record(workspace, upload, "deleted", "recovered", decision.bytes);
    }
  }

  async function sweepChannel(channelId: string, setting: CleanupChannelSetting): Promise<void> {
    if (!setting.enabled || setting.enabledAt === null) return;
    const logged = await deps.log.loggedUploadIds(channelId);
    const uploads = (await deps.doneUploads(channelId, setting.enabledAt)).filter(
      (u) => !logged.has(u.id) && u.finishedAt !== null && u.finishedAt >= (setting.enabledAt as number)
    );
    const forChannel = waiting.get(channelId);
    if (forChannel) for (const id of [...forChannel.keys()]) if (!uploads.some((u) => u.id === id)) forChannel.delete(id);
    if (uploads.length === 0) return;

    const workspace = await deps.workspace(channelId);
    const channelName = workspace
      ? channelNameOfFolder(
          workspace
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() ?? ""
        )
      : "";
    const [active, rotation] = await Promise.all([deps.activeUploadFiles(), deps.liveRotation()]);

    // Local first: only a file that could go costs a YouTube read.
    const ready: Array<{
      upload: CleanupUpload;
      file: CleanupInspected & { kind: "file" };
    }> = [];
    for (const upload of uploads) {
      const inspected: CleanupInspected = workspace ? await deps.fs.inspect(workspace, upload.videoFile) : { kind: "unavailable" };
      const inLiveRotation = rotation.some((r) => r.videoId === upload.videoId || r.originalPath === upload.videoFile);
      const decision = decideLocally({
        upload,
        channelName,
        local: inspected,
        inLiveRotation,
        uploadActive: active.has(upload.videoFile),
      });
      if (decision) await settle(workspace, upload, decision, inspected.kind === "file" ? inspected.bytes : null);
      else if (inspected.kind === "file") ready.push({ upload, file: inspected });
    }
    if (!workspace || ready.length === 0) return;

    // YouTube: one read per 50 videos, by the user who approved them.
    const states = new Map<string, CleanupYoutubeState>();
    const failedUsers = new Set<string>();
    const byUser = new Map<string, string[]>();
    for (const { upload } of ready) byUser.set(upload.approvedBy, [...(byUser.get(upload.approvedBy) ?? []), upload.videoId as string]);
    for (const [approvedBy, ids] of byUser) {
      for (let i = 0; i < ids.length; i += CLEANUP_READ_BATCH) {
        try {
          for (const [id, state] of await deps.readYoutube({
            channelId,
            approvedBy,
            videoIds: ids.slice(i, i + CLEANUP_READ_BATCH),
          }))
            states.set(id, state);
        } catch (error) {
          failedUsers.add(approvedBy);
          deps.note("local_video_cleanup.youtube_unavailable", {
            channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const { upload, file } of ready) {
      const state = states.get(upload.videoId as string);
      const youtube: YoutubeVideoFacts =
        failedUsers.has(upload.approvedBy) && !state
          ? { kind: "unavailable" }
          : state
            ? {
                kind: "ok",
                ...state,
                durationSeconds: isoDurationSeconds(state.duration),
              }
            : { kind: "missing" };
      const onYoutube = decideOnYoutube({ localBytes: file.bytes, youtube });
      if (onYoutube.action !== "delete" || youtube.kind !== "ok") {
        await settle(workspace, upload, onYoutube, file.bytes);
        continue;
      }
      await deleteOne(workspace, channelName, upload, file, youtube);
    }
  }

  async function deleteOne(
    workspace: string,
    channelName: string,
    upload: CleanupUpload,
    file: CleanupInspected & { kind: "file" },
    youtube: Extract<YoutubeVideoFacts, { kind: "ok" }>
  ): Promise<void> {
    if (!file.absolutePath || !file.identity) return settle(workspace, upload, { action: "wait", reason: "workspace_unavailable" }, file.bytes);
    const actualSha256 = upload.sha256 ? await deps.fs.sha256(file.absolutePath).catch(() => null) : null;
    // Review: the duration is needed only without YouTube's size; the tombstone then takes YouTube's duration.
    const localDuration = youtube.fileSize === null ? await deps.fs.probeDuration(file.absolutePath).catch(() => null) : null;
    const content = decideOnContent({
      expectedSha256: upload.sha256,
      actualSha256,
      youtubeFileSize: youtube.fileSize,
      youtubeDurationSeconds: youtube.durationSeconds,
      localDurationSeconds: localDuration,
    });
    if (content.action !== "delete") return settle(workspace, upload, content, file.bytes);
    // Review #4: the owner may have switched the channel off while this sweep hashed files -- asked again right before deleting.
    const still = (await settings()).channels[upload.channelId];
    if (!still?.enabled || still.enabledAt === null || (upload.finishedAt ?? 0) < still.enabledAt) return;
    const tombstone: VideoTombstone = {
      schema: TOMBSTONE_SCHEMA,
      file: upload.videoFile.split("/").pop() as string,
      bytes: file.bytes,
      sha256: actualSha256 ?? upload.sha256 ?? null,
      durationSec: typeof localDuration === "number" ? localDuration : youtube.durationSeconds,
      youtubeVideoId: upload.videoId as string,
      privacyStatus: youtube.privacyStatus ?? "unknown",
      publishAt: youtube.publishAt,
      deletedAt: new Date(deps.clock()).toISOString(),
      deletedBy: CLEANUP_DELETED_BY,
      tempDeleted: [],
    };
    try {
      await deps.fs.writeTombstone(file.absolutePath, tombstone);
    } catch (error) {
      deps.note("local_video_cleanup.tombstone_failed", {
        channelId: upload.channelId,
        video: upload.video,
        error: error instanceof Error ? error.message : String(error),
      });
      return settle(workspace, upload, { action: "wait", reason: "delete_failed" }, file.bytes);
    }
    try {
      await deps.fs.unlink({
        workspace,
        relativePath: upload.videoFile,
        video: upload.video,
        channelName,
        expected: {
          ...file.identity,
          bytes: file.bytes,
          videoId: upload.videoId as string,
        },
      });
    } catch (error) {
      deps.note("local_video_cleanup.unlink_failed", {
        channelId: upload.channelId,
        video: upload.video,
        error: error instanceof Error ? error.message : String(error),
      });
      return settle(workspace, upload, { action: "wait", reason: "delete_failed" }, file.bytes);
    }
    waiting.get(upload.channelId)?.delete(upload.id);
    await record(workspace, upload, "deleted", null, file.bytes);
  }

  async function sweep(): Promise<void> {
    const current = await settings();
    for (const [channelId, setting] of Object.entries(current.channels)) {
      try {
        await sweepChannel(channelId, setting);
      } catch (error) {
        deps.note("local_video_cleanup.sweep_failed", {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    /** One sweep; a call while one runs waits for it (never two at once). */
    async tick(): Promise<void> {
      if (running) return running;
      running = sweep().finally(() => {
        running = null;
      });
      return running;
    },

    /** The owner's switch (Web UI only). Turning it on records the time: only uploads finished from then on are cleaned. */
    async setEnabled(channelId: string, enabled: boolean): Promise<CleanupChannelSetting> {
      const next = switching.then(() => applySwitch(channelId, enabled));
      switching = next.catch(() => undefined);
      return next;
    },

    async view(channelId: string): Promise<CleanupChannelView> {
      return viewOf(channelId);
    },
  };

  async function applySwitch(channelId: string, enabled: boolean): Promise<CleanupChannelSetting> {
    const current = await settings();
    const before = current.channels[channelId];
    const next: CleanupChannelSetting = enabled
      ? {
          enabled: true,
          enabledAt: before?.enabled && before.enabledAt !== null ? before.enabledAt : deps.clock(),
        }
      : { enabled: false, enabledAt: null };
    current.channels[channelId] = next;
    await deps.setSettingsJson(JSON.stringify(current));
    if (!enabled) waiting.delete(channelId);
    deps.note("local_video_cleanup.switch", { channelId, enabled });
    return next;
  }

  async function viewOf(channelId: string): Promise<CleanupChannelView> {
    const setting = (await settings()).channels[channelId] ?? {
      enabled: false,
      enabledAt: null,
    };
    const [freed, recent] = await Promise.all([deps.log.freed(channelId), deps.log.list(channelId, 20)]);
    return {
      channelId,
      enabled: setting.enabled,
      enabledAt: setting.enabledAt !== null ? new Date(setting.enabledAt).toISOString() : null,
      freedBytes: freed.bytes,
      deletedCount: freed.count,
      waiting: [...(waiting.get(channelId)?.values() ?? [])]
        .sort((a, b) => b.checkedAt - a.checkedAt)
        .map((w) => ({
          video: w.video,
          reason: w.reason,
          checkedAt: new Date(w.checkedAt).toISOString(),
        })),
      recent: recent.map((e) => ({
        video: e.video,
        action: e.action,
        reason: e.reason,
        bytes: e.bytes,
        at: new Date(e.at).toISOString(),
        path: e.path,
      })),
    };
  }
}

export type LocalVideoCleanup = ReturnType<typeof createLocalVideoCleanup>;
