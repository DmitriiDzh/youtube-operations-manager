// BL-187 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §3.1, AGENTS.md §M): what the channel workspace's `04 Videos/`
// holds, shared by the feature modules that read it (publishing's release packages, live streams' video picker) so neither
// reaches into the other. Pure: the folder walk takes its directory reads as a dependency; nothing here touches the disk.

/** The factory's layout: `04 Videos/<MM Month>/<MMDD Vn>/…`. */
export const VIDEOS_FOLDER = "04 Videos";
/** `04 Videos/<MM Month>/<MMDD Vn>/<file>`: three levels below the folder at most. */
export const VIDEOS_MAX_DEPTH = 3;
/** The registry of published videos the factory keeps in `04 Videos/` (written outside this repository; not a contract). */
export const VIDEO_REGISTRY_FILE = "video_registry.csv";

/** A directory entry by `lstat`: a symlink is "other", so a walk never leaves the workspace through one. */
export type DirEntry = { name: string; kind: "dir" | "file" | "other" };

export type WalkDeps = {
  /** A directory's entries by `lstat`; [] when it is missing or unreadable. */
  listDir(absolutePath: string): Promise<DirEntry[]>;
  join(...parts: string[]): string;
};

/**
 * Every regular file under `<workspace>/04 Videos/` (at most `VIDEOS_MAX_DEPTH` levels down) whose name `includeFile`
 * accepts, relative to the workspace with `/` between folders, sorted. Hidden folders and symlinks are skipped.
 */
export async function walkVideosFolder(deps: WalkDeps, workspace: string, includeFile: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number) => {
    const entries = await deps.listDir(deps.join(workspace, ...relative.split("/")));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.kind === "file" && includeFile(entry.name)) found.push(child);
      else if (entry.kind === "dir" && depth < VIDEOS_MAX_DEPTH && !entry.name.startsWith(".")) await walk(child, depth + 1);
    }
  };
  await walk(VIDEOS_FOLDER, 1);
  return found.sort();
}

/** A `MMDD Vn` folder of `04 Videos/` (BL-194): its workspace-relative path, its release number and the names of its files. */
export type VideoFolder = { folder: string; video: string; files: string[] };

/**
 * BL-194 (VIDEO_COST_PLAN.md §2 stage 1): every `MMDD Vn` folder under `<workspace>/04 Videos/` -- `04 Videos/<MM Month>/<MMDD Vn>`,
 * or one directly under `04 Videos/` -- with the regular files directly inside it, an empty folder included (the release
 * packages' listing counts only folders with a video). Hidden folders and symlinks are skipped; sorted by path.
 */
export async function listVideoFolders(deps: WalkDeps, workspace: string): Promise<VideoFolder[]> {
  const found: VideoFolder[] = [];
  const visit = async (relative: string, name: string) => {
    const video = videoNumberOfFolder(name);
    if (!video) return false;
    const entries = await deps.listDir(deps.join(workspace, ...relative.split("/")));
    found.push({ folder: relative, video, files: entries.filter((e) => e.kind === "file").map((e) => e.name).sort() });
    return true;
  };
  for (const top of await deps.listDir(deps.join(workspace, VIDEOS_FOLDER))) {
    if (top.kind !== "dir" || top.name.startsWith(".")) continue;
    const topPath = `${VIDEOS_FOLDER}/${top.name}`;
    if (await visit(topPath, top.name)) continue;
    for (const child of await deps.listDir(deps.join(workspace, VIDEOS_FOLDER, top.name))) {
      if (child.kind === "dir" && !child.name.startsWith(".")) await visit(`${topPath}/${child.name}`, child.name);
    }
  }
  return found.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** Written next to the video by the factory or the owner's «Новый пакет» (FO-REQ-0023): the release package. */
export const releaseManifestFileName = (video: string) => `${video}_release.json`;

/** Written next to a release package after an upload by YT Manager (FO-REQ-0023 §4 A2). */
export const uploadRecordFileName = (video: string) => `${video}_youtube.json`;

/** The factory's text files carry a BOM, which `JSON.parse` does not accept. */
export function stripBom(text: string): string {
  return text.replace(/^﻿/, "");
}

/** The uploaded video's id from a `Vn_youtube.json` text; null when the text is not JSON or names no video. */
export function parseUploadRecord(text: string): { videoId: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch {
    return null;
  }
  const videoId = value && typeof value === "object" ? (value as { videoId?: unknown }).videoId : undefined;
  return typeof videoId === "string" && videoId !== "" ? { videoId } : null;
}

/** The release number a `MMDD Vn` folder is named after (`0928 V39` → `V39`), upper-cased; null for any other name. */
export function videoNumberOfFolder(folderName: string): string | null {
  const match = /^\d{4}\s+(V\d+)(?:\s|$)/i.exec(folderName);
  return match ? match[1].toUpperCase() : null;
}

/** The video files a release can be: `.mp4`, `.mov`, `.m4v`. */
export function isVideoFileName(name: string): boolean {
  return /\.(mp4|mov|m4v)$/i.test(name) && !name.startsWith(".");
}

/** Whether `fileName` is named after release `video` (`V39 Tropico Jazz.mp4` for V39, never for V3): Vn then space, `_`, `.` or end. */
export function isNamedAfterRelease(fileName: string, video: string): boolean {
  if (!fileName.toUpperCase().startsWith(video.toUpperCase())) return false;
  const next = fileName.charAt(video.length);
  return next === "" || next === " " || next === "_" || next === ".";
}

export type VideoRegistryRow = { vNumber: string | null; videoId: string; folder: string };

/** One CSV record per line, RFC 4180 quoting (a quoted field may hold commas and doubled quotes; not newlines). */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * The rows of `video_registry.csv` that name a video and its folder (relative to `04 Videos/`). Read tolerantly: the file is
 * written outside this repository, so a missing column gives no rows and a malformed row is skipped -- never an error.
 */
export function parseVideoRegistry(text: string): VideoRegistryRow[] {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const header = csvFields(lines[0]).map((name) => name.trim());
  const idColumn = header.indexOf("YouTubeVideoId");
  const folderColumn = header.indexOf("Folder");
  const numberColumn = header.indexOf("VNumber");
  if (idColumn < 0 || folderColumn < 0) return [];
  const rows: VideoRegistryRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = csvFields(line);
    const videoId = (fields[idColumn] ?? "").trim();
    // Relative to `04 Videos/`; a value written relative to the workspace (`04 Videos/<MM Month>/<MMDD Vn>`) is read the same.
    const folder = (fields[folderColumn] ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(new RegExp(`^${VIDEOS_FOLDER}/`), "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || folder === "") continue;
    const vNumber = numberColumn >= 0 ? (fields[numberColumn] ?? "").trim().toUpperCase() || null : null;
    rows.push({ vNumber, videoId, folder });
  }
  return rows;
}

export { createWorkspaceVideoFiles } from "./adapters/files";
export { writeUploadRecordFile } from "./adapters/upload-record";
