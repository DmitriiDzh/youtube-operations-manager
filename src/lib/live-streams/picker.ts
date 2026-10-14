import { isNamedAfterRelease, videoNumberOfFolder, VIDEOS_FOLDER, type VideoRegistryRow } from "@/lib/workspace-videos";
import { DURATION_TOLERANCE_SECONDS } from "./contracts";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): the «Добавить видео…» dialog's rows -- the channel workspace's video files
// under `04 Videos/`, each with the YouTube video it is (when the app knows it) and whether it can be added. Pure: the
// files, records and videos are read by the caller. Nothing here adds anything: every add still goes through `addVideo`'s
// own checks (channel video, public read fresh, file in the workspace, duration within 1 s).

export type PickerVideo = {
  videoId: string;
  title: string;
  privacyStatus: string;
  publishAt: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};

/** Where a match came from, strongest first: the Operator's map, YT Manager's upload record, the factory's registry. */
export type MatchSource = "operator_map" | "upload_record" | "registry";
const SOURCE_ORDER: readonly MatchSource[] = ["operator_map", "upload_record", "registry"];

export type PickerInputs = {
  /** Every video file found under `04 Videos/` (workspace-relative); the duration is ffprobe's, null when unknown. */
  files: Array<{ relativePath: string; bytes: number; durationSeconds: number | null }>;
  /** `Vn_youtube.json`'s video id per release folder (workspace-relative folder). */
  uploadRecords: Record<string, string>;
  /** `video_registry.csv`'s rows (folders relative to `04 Videos/`); null when there is none. */
  registry: VideoRegistryRow[] | null;
  /** The Operator's map of videos to their files (`live_stream_sources`). */
  sources: Array<{ videoId: string; originalPath: string }>;
  /** The channel's videos (the synced copy, removed ones excluded). */
  channelVideos: PickerVideo[];
  rotation: Array<{ videoId: string; originalPath: string }>;
  /** «Показать все файлы»: source clips and folders without a V-number too. */
  showAll: boolean;
  now: Date;
};

export type PickerRowState = "available" | "in_rotation" | "not_public" | "conflict" | "needs_choice";

export type PickerRow = {
  file: string;
  folder: string;
  fileName: string;
  bytes: number;
  durationSeconds: number | null;
  /** The folder's release number (`MMDD Vn`), or null. */
  vNumber: string | null;
  /** The folder's one file named after its release (the video that was published). */
  release: boolean;
  match: (PickerVideo & { source: MatchSource }) | null;
  /** Sources that name different videos for this file (then there is no match). */
  conflict: Array<{ source: MatchSource; videoId: string }>;
  /** Videos the owner may choose from when there is no match: the conflicting ones, then the channel's within 1 s. */
  suggestions: PickerVideo[];
  state: PickerRowState;
};

/** Public with no future `publishAt`, as the synced copy says (the add reads YouTube fresh). */
function isPublicNow(video: PickerVideo, now: Date): boolean {
  if (video.privacyStatus !== "public") return false;
  const at = video.publishAt ? Date.parse(video.publishAt) : NaN;
  return !(Number.isFinite(at) && at > now.getTime());
}

const newestFirst = (a: PickerVideo, b: PickerVideo) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

function releaseNumber(vNumber: string | null): number {
  return vNumber ? Number(vNumber.slice(1)) : Number.POSITIVE_INFINITY;
}

export function buildPickerRows(input: PickerInputs): PickerRow[] {
  const videos = new Map(input.channelVideos.map((v) => [v.videoId, v]));
  const inRotationIds = new Set(input.rotation.map((r) => r.videoId));
  const inRotationFiles = new Set(input.rotation.map((r) => r.originalPath));
  const folderOf = (file: string) => file.slice(0, file.lastIndexOf("/"));

  // A folder's release file: the one video file named after the folder's Vn. Several such files: none is "the" release, so
  // the folder-level sources (upload record, registry) match none of them.
  const releaseNamed = new Map<string, string[]>();
  for (const file of input.files) {
    const folder = folderOf(file.relativePath);
    const vNumber = videoNumberOfFolder(folder.slice(folder.lastIndexOf("/") + 1));
    if (vNumber && isNamedAfterRelease(file.relativePath.slice(folder.length + 1), vNumber)) {
      releaseNamed.set(folder, [...(releaseNamed.get(folder) ?? []), file.relativePath]);
    }
  }

  const rows: PickerRow[] = [];
  for (const file of input.files) {
    const folder = folderOf(file.relativePath);
    const fileName = file.relativePath.slice(folder.length + 1);
    const vNumber = videoNumberOfFolder(folder.slice(folder.lastIndexOf("/") + 1));
    const named = releaseNamed.get(folder) ?? [];
    const isReleaseNamed = named.includes(file.relativePath);
    if (!isReleaseNamed && !input.showAll) continue;
    const soleRelease = isReleaseNamed && named.length === 1;

    const claims: Array<{ source: MatchSource; videoId: string }> = [];
    for (const s of input.sources) if (s.originalPath === file.relativePath) claims.push({ source: "operator_map", videoId: s.videoId });
    if (soleRelease) {
      const recorded = input.uploadRecords[folder];
      if (recorded) claims.push({ source: "upload_record", videoId: recorded });
      const inVideos = folder.startsWith(`${VIDEOS_FOLDER}/`) ? folder.slice(VIDEOS_FOLDER.length + 1) : null;
      for (const r of input.registry ?? []) if (inVideos !== null && r.folder === inVideos) claims.push({ source: "registry", videoId: r.videoId });
    }
    // Only the channel's own videos can be a match (a registry row may name any id).
    const valid = claims.filter((c) => videos.has(c.videoId));
    const distinct = [...new Set(valid.map((c) => c.videoId))];

    let match: PickerRow["match"] = null;
    let conflict: PickerRow["conflict"] = [];
    if (distinct.length === 1) {
      const source = SOURCE_ORDER.find((s) => valid.some((c) => c.source === s))!;
      match = { ...videos.get(distinct[0])!, source };
    } else if (distinct.length > 1) {
      conflict = SOURCE_ORDER.flatMap((s) => valid.filter((c) => c.source === s)).filter(
        (c, i, all) => all.findIndex((o) => o.source === c.source && o.videoId === c.videoId) === i,
      );
    }

    let suggestions: PickerVideo[] = [];
    if (!match) {
      const conflicting = distinct.map((id) => videos.get(id)!);
      const byDuration =
        file.durationSeconds === null
          ? []
          : input.channelVideos.filter(
              (v) =>
                v.durationSeconds !== null &&
                Math.abs(v.durationSeconds - file.durationSeconds!) <= DURATION_TOLERANCE_SECONDS &&
                !inRotationIds.has(v.videoId) &&
                !distinct.includes(v.videoId),
            );
      const now = input.now;
      byDuration.sort((a, b) => Number(isPublicNow(b, now)) - Number(isPublicNow(a, now)) || newestFirst(a, b));
      suggestions = [...conflicting, ...byDuration];
    }

    const state: PickerRowState =
      inRotationFiles.has(file.relativePath) || (match && inRotationIds.has(match.videoId))
        ? "in_rotation"
        : conflict.length > 0
          ? "conflict"
          : !match
            ? "needs_choice"
            : isPublicNow(match, input.now)
              ? "available"
              : "not_public";

    rows.push({
      file: file.relativePath,
      folder,
      fileName,
      bytes: file.bytes,
      durationSeconds: file.durationSeconds,
      vNumber,
      release: isReleaseNamed,
      match,
      conflict,
      suggestions,
      state,
    });
  }
  rows.sort((a, b) => releaseNumber(a.vNumber) - releaseNumber(b.vNumber) || Number(b.release) - Number(a.release) || a.file.localeCompare(b.file));
  return rows;
}
