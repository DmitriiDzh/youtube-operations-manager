import {
  imageKindOf,
  packageProblems,
  parseReleasePackage,
  RELEASE_PACKAGE_FILE_PATTERN,
  youtubeRecordFileName,
  type ChannelExpectations,
  type PackageProblem,
  type ReleasePackage,
} from "./packages";

// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 items 1 and 3; FO-REQ-0023 §6 question 1, "the scan"): the channel's release
// packages, found under `<workspace>/04 Videos/`, each checked again and given its state. Read-only: nothing on disk is changed.

export const VIDEOS_FOLDER = "04 Videos";
/** `04 Videos/<MM Month>/<MMDD Vn>/Vn_release.json`: three levels below the folder at most. */
const MAX_DEPTH = 3;
/** A manifest is a few kilobytes; anything far larger is not one. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

export type PackageState = "not_ready" | "ready" | "uploaded_private" | "scheduled" | "published" | "uploaded_unknown";

export type ScannedPackage = {
  /** The manifest, relative to the workspace (`/` between folders). */
  manifestPath: string;
  folder: string;
  video: string | null;
  title: string | null;
  plannedPublishDate: string | null;
  thumbnailPath: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  state: PackageState;
  problems: PackageProblem[];
  /** From `Vn_youtube.json`, once uploaded. */
  youtube: { videoId: string; privacyStatus: string | null; publishAt: string | null } | null;
  /** The parsed manifest, for the approval screen (null when it is not a valid one). */
  pkg: ReleasePackage | null;
};

export type PackageScanResult =
  | { status: "no_workspace" }
  | { status: "workspace_unavailable"; reason: string }
  | { status: "ok"; packages: ScannedPackage[] };

export type DirEntry = { name: string; kind: "dir" | "file" | "other" };

export type PackageScanDeps = {
  /** The channel's workspace path on this computer, or null when not set (`channel-workspaces`). */
  workspace(channelId: string): Promise<string | null>;
  /** A directory's entries by `lstat`: a symlink is "other", so the walk never leaves the workspace through one. [] when missing. */
  listDir(absolutePath: string): Promise<DirEntry[]>;
  /** The workspace rule (`workspace-exchange.resolveWorkspaceFile`): a regular file whose real path is inside the workspace. */
  resolveFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
  readText(absolutePath: string, maxBytes: number): Promise<string>;
  readHead(absolutePath: string, bytes: number): Promise<Uint8Array>;
  /** ffprobe's duration in seconds; null when the file cannot be read as a video. */
  probeDuration(absolutePath: string, bytes: number): Promise<number | null>;
  channel(channelId: string): Promise<ChannelExpectations>;
  /** The channel's synced videos (the local copy). */
  videos(channelId: string): Promise<Array<{ videoId: string; title: string; privacyStatus: string; publishAt: string | null }>>;
  /** Whether `workspace` is usable now (`local-path-validation`, re-run at use time). */
  validateWorkspace(workspace: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  join(...parts: string[]): string;
  clock: { now(): Date };
};

async function findManifests(deps: PackageScanDeps, workspace: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number) => {
    const entries = await deps.listDir(deps.join(workspace, ...relative.split("/")));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.kind === "file" && RELEASE_PACKAGE_FILE_PATTERN.test(entry.name)) found.push(child);
      else if (entry.kind === "dir" && depth < MAX_DEPTH && !entry.name.startsWith(".")) await walk(child, depth + 1);
    }
  };
  await walk(VIDEOS_FOLDER, 1);
  return found.sort();
}

function stateOf(record: { videoId: string } | null, video: { privacyStatus: string; publishAt: string | null } | undefined, problems: PackageProblem[], nowMs: number): PackageState {
  if (record) {
    if (!video) return "uploaded_unknown";
    if (video.privacyStatus !== "private") return "published";
    const at = video.publishAt ? Date.parse(video.publishAt) : NaN;
    return Number.isFinite(at) && at > nowMs ? "scheduled" : "uploaded_private";
  }
  return problems.length > 0 ? "not_ready" : "ready";
}

export function createPackageScan(deps: PackageScanDeps) {
  async function readJson(path: string): Promise<unknown> {
    // The factory's text files carry a BOM; JSON.parse does not accept one.
    return JSON.parse((await deps.readText(path, MANIFEST_MAX_BYTES)).replace(/^﻿/, ""));
  }

  async function scanOne(workspace: string, manifestPath: string, channel: ChannelExpectations, videos: Awaited<ReturnType<PackageScanDeps["videos"]>>): Promise<ScannedPackage | null> {
    const manifest = await deps.resolveFile(workspace, manifestPath);
    if (!manifest) return null;
    const folder = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    const base: ScannedPackage = { manifestPath, folder, video: null, title: null, plannedPublishDate: null, thumbnailPath: null, sizeBytes: null, durationSeconds: null, state: "not_ready", problems: [], youtube: null, pkg: null };
    let raw: unknown;
    try {
      raw = await readJson(manifest.path);
    } catch {
      return { ...base, problems: [{ code: "invalid_json" }] };
    }
    const parsed = parseReleasePackage(raw);
    if (!parsed.pkg) return { ...base, problems: parsed.problems };
    const pkg = parsed.pkg;

    const videoFile = await deps.resolveFile(workspace, `${folder}/${pkg.files.video}`);
    const durationSeconds = videoFile ? await deps.probeDuration(videoFile.path, videoFile.bytes) : null;
    const thumbnailFile = await deps.resolveFile(workspace, `${folder}/${pkg.files.thumbnail}`);
    const thumbnailKind = thumbnailFile ? imageKindOf(await deps.readHead(thumbnailFile.path, 8)) : null;
    const recordFile = await deps.resolveFile(workspace, `${folder}/${youtubeRecordFileName(pkg.video)}`);
    let record: { videoId: string } | null = null;
    if (recordFile) {
      const value = await readJson(recordFile.path).catch(() => null);
      const videoId = value && typeof value === "object" ? (value as { videoId?: unknown }).videoId : undefined;
      record = typeof videoId === "string" && videoId !== "" ? { videoId } : null;
    }
    const sameTitle = videos.find((video) => video.title === pkg.title);
    const problems = packageProblems(
      pkg,
      {
        video: { exists: videoFile !== null, sizeBytes: videoFile?.bytes ?? null, durationSeconds, probeFailed: videoFile !== null && durationSeconds === null },
        thumbnail: { exists: thumbnailFile !== null, sizeBytes: thumbnailFile?.bytes ?? null, kind: thumbnailKind },
        youtubeRecordExists: recordFile !== null,
        sameTitleVideoId: sameTitle?.videoId ?? null,
      },
      channel
    );
    if (recordFile && !record) problems.push({ code: "youtube_record_invalid" });
    const uploaded = record ? videos.find((video) => video.videoId === record.videoId) : undefined;
    return {
      ...base,
      video: pkg.video,
      title: pkg.title,
      plannedPublishDate: pkg.plannedPublishDate,
      thumbnailPath: thumbnailFile ? `${folder}/${pkg.files.thumbnail}` : null,
      sizeBytes: pkg.sizeBytes,
      durationSeconds: pkg.durationSeconds,
      state: stateOf(record, uploaded, problems, deps.clock.now().getTime()),
      problems: record ? [] : problems,
      youtube: record ? { videoId: record.videoId, privacyStatus: uploaded?.privacyStatus ?? null, publishAt: uploaded?.publishAt ?? null } : null,
      pkg,
    };
  }

  return {
    /** Every package of the channel, by planned date (undated last), then by video number. */
    async scan(channelId: string): Promise<PackageScanResult> {
      const workspace = await deps.workspace(channelId);
      if (!workspace) return { status: "no_workspace" };
      const validation = await deps.validateWorkspace(workspace);
      if (!validation.ok) return { status: "workspace_unavailable", reason: validation.reason };
      const [channel, videos, manifests] = await Promise.all([deps.channel(channelId), deps.videos(channelId), findManifests(deps, workspace)]);
      const packages: ScannedPackage[] = [];
      for (const manifestPath of manifests) {
        const scanned = await scanOne(workspace, manifestPath, channel, videos);
        if (scanned) packages.push(scanned);
      }
      const number = (p: ScannedPackage) => Number(/\d+/.exec(p.video ?? p.manifestPath.split("/").pop() ?? "")?.[0] ?? 0);
      packages.sort((a, b) => (a.plannedPublishDate ?? "9999") .localeCompare(b.plannedPublishDate ?? "9999") || number(a) - number(b));
      return { status: "ok", packages };
    },
  };
}

export type PackageScan = ReturnType<typeof createPackageScan>;
