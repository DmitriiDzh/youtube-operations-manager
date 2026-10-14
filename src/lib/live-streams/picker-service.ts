import { uploadRecordFileName, videoNumberOfFolder, type VideoRegistryRow } from "@/lib/workspace-videos";
import { buildPickerRows, type PickerRow, type PickerVideo } from "./picker";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): what the «Добавить видео…» dialog lists -- the channel workspace's
// `04 Videos/` read through the shared `workspace-videos` rules, each file matched to the channel's videos. Read-only:
// nothing on disk or on YouTube changes, and nothing is added (the dialog's «Добавить N» is `addVideos`).

export type PickerDependencies = {
  workspace(channelId: string): Promise<{ configured: false } | { configured: true; path: string }>;
  /** Whether the workspace is usable now (`local-path-validation`, re-run at use time; the T9 may be unmounted). */
  validateWorkspace(workspace: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Every video file under `04 Videos/`, workspace-relative (the shared walk: never through a symlink). */
  listVideoFiles(workspace: string): Promise<string[]>;
  /** A file reached through the workspace rule, with ffprobe's duration (null: unreadable; "no_ffprobe": not installed). */
  describe(workspace: string, relativePath: string): Promise<{ bytes: number; durationSeconds: number | null | "no_ffprobe" } | null>;
  /** The video id in a `Vn_youtube.json`, or null when there is none or it names no video. */
  readUploadRecord(workspace: string, relativePath: string): Promise<string | null>;
  /** `04 Videos/video_registry.csv`'s rows, or null when there is no such file. */
  readRegistry(workspace: string): Promise<VideoRegistryRow[] | null>;
  channelVideos(channelId: string): Promise<PickerVideo[]>;
  rotation(channelId: string): Promise<Array<{ videoId: string; originalPath: string }>>;
  sources(channelId: string): Promise<Array<{ videoId: string; originalPath: string }>>;
  clock: () => Date;
};

export type PickerResult =
  | { status: "no_workspace" }
  | { status: "workspace_unavailable"; reason: string }
  | { status: "ok"; rows: PickerRow[]; ffprobeMissing: boolean; registryFound: boolean; filesFound: number };

/** At most this many files are probed at once (ffprobe reads only the headers, but the T9 is a USB disk). */
const PROBE_CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    }),
  );
  return out;
}

export function createRotationPicker(deps: PickerDependencies) {
  return {
    async listCandidates(channelId: string, options: { showAll: boolean }): Promise<PickerResult> {
      const workspace = await deps.workspace(channelId);
      if (!workspace.configured) return { status: "no_workspace" };
      const validation = await deps.validateWorkspace(workspace.path);
      if (!validation.ok) return { status: "workspace_unavailable", reason: validation.reason };
      const root = workspace.path;

      const [paths, registry, channelVideos, rotation, sources] = await Promise.all([
        deps.listVideoFiles(root),
        deps.readRegistry(root),
        deps.channelVideos(channelId),
        deps.rotation(channelId),
        deps.sources(channelId),
      ]);
      const now = deps.clock();
      const base = { registry, sources, channelVideos, rotation, showAll: options.showAll, now };

      // Which files the dialog shows decides which are probed: a first pass without durations.
      const shown = buildPickerRows({ ...base, files: paths.map((relativePath) => ({ relativePath, bytes: 0, durationSeconds: null })), uploadRecords: {} });
      let ffprobeMissing = false;
      const described = await mapLimited(shown, PROBE_CONCURRENCY, async (row) => {
        const file = await deps.describe(root, row.file);
        if (!file) return null;
        if (file.durationSeconds === "no_ffprobe") ffprobeMissing = true;
        return { relativePath: row.file, bytes: file.bytes, durationSeconds: typeof file.durationSeconds === "number" ? file.durationSeconds : null };
      });

      const uploadRecords: Record<string, string> = {};
      const releaseFolders = [...new Set(shown.filter((r) => r.release).map((r) => r.folder))];
      await Promise.all(
        releaseFolders.map(async (folder) => {
          const vNumber = videoNumberOfFolder(folder.slice(folder.lastIndexOf("/") + 1));
          if (!vNumber) return;
          const videoId = await deps.readUploadRecord(root, `${folder}/${uploadRecordFileName(vNumber)}`);
          if (videoId) uploadRecords[folder] = videoId;
        }),
      );

      const files = described.filter((f): f is NonNullable<typeof f> => f !== null);
      return {
        status: "ok",
        rows: buildPickerRows({ ...base, files, uploadRecords }),
        ffprobeMissing,
        registryFound: registry !== null,
        filesFound: paths.length,
      };
    },
  };
}

export type RotationPicker = ReturnType<typeof createRotationPicker>;
