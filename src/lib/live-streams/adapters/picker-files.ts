import path from "node:path";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import {
  createWorkspaceVideoFiles,
  isVideoFileName,
  parseUploadRecord,
  parseVideoRegistry,
  VIDEO_REGISTRY_FILE,
  VIDEOS_FOLDER,
  walkVideosFolder,
} from "@/lib/workspace-videos";
import { isLibraryPath } from "../library";
import type { PickerDependencies } from "../picker-service";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): the picker's reads of the channel workspace. The walk is the shared
// `workspace-videos` one (never through a symlink); every file is reached through the workspace rule (its real path inside
// the workspace); ffprobe durations are kept per path, size and modification time, so reopening the dialog is quick.

/** `Vn_youtube.json` is a few hundred bytes; the registry a few kilobytes per hundred rows. */
const RECORD_MAX_BYTES = 1024 * 1024;
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;

const holder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const PROBE_CACHE_KEY = Symbol.for("ytom.liveStreams.pickerProbeCache");

export function createPickerFiles(): Pick<PickerDependencies, "validateWorkspace" | "listVideoFiles" | "describe" | "readUploadRecord" | "readRegistry"> {
  const files = createWorkspaceVideoFiles();
  const cache = (holder[PROBE_CACHE_KEY] ??= new Map<string, number | null>()) as Map<string, number | null>;
  let tools: Promise<FfmpegTools | null> | null = null;

  async function resolve(workspace: string, relativePath: string): Promise<{ path: string; bytes: number } | null> {
    try {
      const file = await resolveWorkspaceFile({
        workspace,
        relativePath,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
      return { path: file.path, bytes: file.bytes };
    } catch {
      return null;
    }
  }

  return {
    async validateWorkspace(workspace) {
      const result = await validateOperatorDirectoryPath(workspace);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    // BL-234: the segment library (`04 Videos/Live Segments/`) is not offered as published videos.
    listVideoFiles: async (workspace) =>
      (await walkVideosFolder({ listDir: (p) => files.listDir(p), join: (...parts) => path.join(...parts) }, workspace, isVideoFileName)).filter((file) => !isLibraryPath(file)),
    async describe(workspace, relativePath) {
      const file = await resolve(workspace, relativePath);
      if (!file) return null;
      const key = `${file.path}|${file.bytes}|${await files.modifiedMs(file.path)}`;
      if (cache.has(key)) return { bytes: file.bytes, durationSeconds: cache.get(key) ?? null };
      tools ??= detectFfmpeg();
      const found = await tools;
      if (!found) {
        tools = null; // look again next time (ffmpeg may be installed meanwhile)
        return { bytes: file.bytes, durationSeconds: "no_ffprobe" };
      }
      const duration = await probeMedia(found, file.path).then(
        (probe) => probe.durationSeconds,
        () => null,
      );
      cache.set(key, duration);
      return { bytes: file.bytes, durationSeconds: duration };
    },
    async readUploadRecord(workspace, relativePath) {
      const file = await resolve(workspace, relativePath);
      if (!file) return null;
      const text = await files.readText(file.path, RECORD_MAX_BYTES).catch(() => null);
      return text === null ? null : (parseUploadRecord(text)?.videoId ?? null);
    },
    async readRegistry(workspace) {
      const file = await resolve(workspace, `${VIDEOS_FOLDER}/${VIDEO_REGISTRY_FILE}`);
      if (!file) return null;
      const text = await files.readText(file.path, REGISTRY_MAX_BYTES).catch(() => null);
      return text === null ? null : parseVideoRegistry(text);
    },
  };
}
