import path from "node:path";
import { DURATION_TOLERANCE_SECONDS, MAX_AUDIO_CHANNELS, SUPPORTED_AUDIO_SAMPLE_RATES, type ProbeResult } from "./contracts";
import { canCopyIntoBuffer, checkOriginal, planBuffer } from "./rotation";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.5, decided by the owner in msgs 2575/2578) -- the rolling buffer: copies of the
// originals of the video now playing and the next ones, on the internal disk, so the stream does not need the T9 for the
// next ~2 h. A copy is written as `<videoId>.mp4.part` and renamed to `<videoId>.mp4` only after its checks, so the
// encoder never opens an incomplete file. A copy is removed only once the encoder has moved past it.
// ---------------------------------------------------------------------------

export type BufferFs = {
  mkdirp(dir: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
  size(file: string): Promise<number | null>;
  freeBytes(dir: string): Promise<number>;
};

export type BufferMissingReason = "source_unavailable" | "disk_full" | "copy_failed" | "check_failed";

export type BufferVideo = { videoId: string; originalPath: string; videoDurationSeconds: number | null };

export type BufferDependencies = {
  fs: BufferFs;
  /** `<appData>/live-streams` (platform-paths). */
  bufferRoot: string;
  resolveOriginal(channelId: string, relativePath: string): Promise<{ ok: true; path: string; bytes: number } | { ok: false; workspaceMissing: boolean; detail: string }>;
  probe(file: string): Promise<ProbeResult>;
  /** Real changes only; a missing copy is returned to the caller, which records it once per change (it is retried often). */
  event(channelId: string, kind: "buffer_copied" | "buffer_removed", detail: Record<string, unknown>): Promise<void>;
  /** Milliseconds, for the copy time in the event. */
  now(): number;
};

const COPY_NAME = /^([A-Za-z0-9_-]{11})\.mp4$/;
const PART_NAME = /^[A-Za-z0-9_-]{11}\.mp4\.part$/;

export function createLiveStreamBuffer(deps: BufferDependencies) {
  const dirOf = (channelId: string) => path.join(deps.bufferRoot, channelId);
  const fileOf = (channelId: string, videoId: string) => path.join(dirOf(channelId), `${videoId}.mp4`);

  async function present(channelId: string): Promise<string[]> {
    return (await deps.fs.list(dirOf(channelId))).map((name) => COPY_NAME.exec(name)?.[1]).filter((id): id is string => Boolean(id));
  }

  /** One copy: original -> `.part` -> checks -> final name. A failure leaves nothing behind. */
  async function copyOne(
    channelId: string,
    video: BufferVideo,
    refuseBelowBytes: number
  ): Promise<{ ok: true } | { ok: false; reason: BufferMissingReason; detail: string }> {
    const source = await deps.resolveOriginal(channelId, video.originalPath);
    if (!source.ok) return { ok: false, reason: "source_unavailable", detail: source.detail };
    const free = await deps.fs.freeBytes(dirOf(channelId));
    if (!canCopyIntoBuffer({ freeBytes: free, fileBytes: source.bytes, refuseBelowBytes })) {
      return { ok: false, reason: "disk_full", detail: `copying ${source.bytes} bytes would leave less than ${refuseBelowBytes} bytes free` };
    }
    const part = `${fileOf(channelId, video.videoId)}.part`;
    const started = deps.now();
    try {
      await deps.fs.copy(source.path, part);
      const copied = await deps.fs.size(part);
      if (copied !== source.bytes) {
        await deps.fs.remove(part).catch(() => undefined);
        return { ok: false, reason: "check_failed", detail: `the copy has ${copied ?? "no"} bytes, the original ${source.bytes}` };
      }
      const problem = checkOriginal(await deps.probe(part), video.videoDurationSeconds, {
        toleranceSeconds: DURATION_TOLERANCE_SECONDS,
        sampleRates: SUPPORTED_AUDIO_SAMPLE_RATES,
        maxChannels: MAX_AUDIO_CHANNELS,
      });
      if (problem) {
        await deps.fs.remove(part).catch(() => undefined);
        return { ok: false, reason: "check_failed", detail: problem };
      }
      await deps.fs.rename(part, fileOf(channelId, video.videoId));
    } catch (error) {
      await deps.fs.remove(part).catch(() => undefined);
      return { ok: false, reason: "copy_failed", detail: error instanceof Error ? error.message : String(error) };
    }
    await deps.event(channelId, "buffer_copied", { videoId: video.videoId, bytes: source.bytes, ms: deps.now() - started });
    return { ok: true };
  }

  return {
    fileOf,

    /**
     * Brings the buffer to the plan for the current position: copies what is missing, in the order it is needed, then
     * removes what is no longer wanted. A copy is removed only after the copies that replace it are in place, so when
     * the T9 is gone the buffer still holds `depth` videos to replay; only a copy refused for disk space frees the
     * unwanted ones first and tries again. Stops at the first copy that fails (the later ones are needed even later).
     * Leftover `.part` files (an interrupted copy) are removed first.
     */
    async sync(
      channelId: string,
      args: {
        order: readonly string[];
        currentIndex: number;
        nextPassFirst: string | null;
        depth: number;
        refuseBelowBytes: number;
        videos: readonly BufferVideo[];
      }
    ): Promise<{ present: string[]; copied: string[]; removed: string[]; missing: { videoId: string; reason: BufferMissingReason; detail: string } | null }> {
      await deps.fs.mkdirp(dirOf(channelId));
      for (const name of await deps.fs.list(dirOf(channelId))) {
        if (PART_NAME.test(name)) await deps.fs.remove(path.join(dirOf(channelId), name)).catch(() => undefined);
      }
      const planNow = async () =>
        planBuffer({ order: args.order, currentIndex: args.currentIndex, nextPassFirst: args.nextPassFirst, depth: args.depth, present: await present(channelId) });
      const copied: string[] = [];
      const removed: string[] = [];
      const removeUnwanted = async (ids: readonly string[]) => {
        for (const videoId of ids) {
          await deps.fs.remove(fileOf(channelId, videoId));
          removed.push(videoId);
          await deps.event(channelId, "buffer_removed", { videoId });
        }
      };
      const copyMissing = async (ids: readonly string[]) => {
        for (const videoId of ids) {
          const video = args.videos.find((v) => v.videoId === videoId);
          const result = video
            ? await copyOne(channelId, video, args.refuseBelowBytes)
            : { ok: false as const, reason: "source_unavailable" as const, detail: "the video is no longer in the rotation" };
          if (!result.ok) return { videoId, reason: result.reason, detail: result.detail };
          copied.push(videoId);
        }
        return null;
      };

      let plan = await planNow();
      let missing = await copyMissing(plan.copy);
      if (missing?.reason === "disk_full" && plan.remove.length > 0) {
        await removeUnwanted(plan.remove);
        plan = await planNow();
        missing = await copyMissing(plan.copy);
      }
      if (!missing) await removeUnwanted((await planNow()).remove);
      return { present: await present(channelId), copied, removed, missing };
    },
  };
}

export type LiveStreamBuffer = ReturnType<typeof createLiveStreamBuffer>;
