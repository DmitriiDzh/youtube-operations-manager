import { VIDEO_DELETED_ON_YOUTUBE } from "@/lib/shared-video-presence";
import { parseUploadRecord, stripBom, VIDEOS_FOLDER, walkVideosFolder, type DirEntry } from "@/lib/workspace-videos";
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

export { VIDEOS_FOLDER };
export type { DirEntry };
/** A manifest is a few kilobytes; anything far larger is not one. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** A path the preview may serve: an image (by name) under `04 Videos/`, relative, with no `..`; the content is checked too. */
export function isPackageThumbnailPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return relativePath.startsWith(`${VIDEOS_FOLDER}/`) && /\.(jpe?g|png)$/i.test(relativePath) && !relativePath.includes("\\") && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * BL-243: `uploaded_unknown` -- the upload record names a video the synced copy does not have (uploaded after the last sync): not a
 * confirmation it exists. `deleted_on_youtube` -- the copy has it with the sync's removed mark (`videos.removed_on_youtube_at`).
 */
export type PackageState = "not_ready" | "ready" | "uploaded_private" | "scheduled" | "published" | "uploaded_unknown" | "deleted_on_youtube";

export type ScannedPackage = {
  /** The manifest, relative to the workspace (`/` between folders). */
  manifestPath: string;
  folder: string;
  video: string | null;
  title: string | null;
  plannedPublishDate: string | null;
  thumbnailPath: string | null;
  /** BL-225 stage 2: a v2 package's test thumbnails found on disk (relative to the workspace), for the owner's Test & Compare. */
  testThumbnailPaths?: string[];
  sizeBytes: number | null;
  durationSeconds: number | null;
  state: PackageState;
  problems: PackageProblem[];
  /** From `Vn_youtube.json`, once uploaded. BL-243: `removedAt` (ISO) when the sync found the video removed on YouTube. */
  youtube: { videoId: string; privacyStatus: string | null; publishAt: string | null; removedAt?: string | null; uploadedAt?: string | null } | null;
  /**
   * BL-243: the uploaded video is in the synced copy, not removed, as of a completed removed check (true), removed on YouTube (false), or
   * unknown -- no upload record, or a video id the copy does not have (null).
   */
  existsOnChannel: boolean | null;
  /**
   * BL-243: when a channel sync last completed its removed-on-YouTube check (ISO; `channels.removed_check_at`), what
   * `existsOnChannel` stands on; null: never (then no video is "on the channel" -- true needs it).
   */
  checkedAt: string | null;
  /** The parsed manifest, for the approval screen (null when it is not a valid one). */
  pkg: ReleasePackage | null;
  /** The manifest file's SHA-256: an approval names it, so a package changed after the owner saw it is refused. */
  manifestSha256: string | null;
};

export type PackageScanResult =
  | { status: "no_workspace" }
  | { status: "workspace_unavailable"; reason: string }
  | {
      status: "ok";
      packages: ScannedPackage[];
      /**
       * BL-243: the ids of the channel's videos the sync found removed, as this scan read them ([] when
       * that read failed: none known). The plan progress reuses them, so it never disagrees with the packages it shows.
       */
      removedVideoIds: string[];
    };

export type PackageScanDeps = {
  /** The channel's workspace path on this computer, or null when not set (`channel-workspaces`). */
  workspace(channelId: string): Promise<string | null>;
  /** A directory's entries by `lstat`: a symlink is "other", so the walk never leaves the workspace through one. [] when missing. */
  listDir(absolutePath: string): Promise<DirEntry[]>;
  /** The workspace rule (`workspace-exchange.resolveWorkspaceFile`): a regular file whose real path is inside the workspace. */
  resolveFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
  readText(absolutePath: string, maxBytes: number): Promise<string>;
  readHead(absolutePath: string, bytes: number): Promise<Uint8Array>;
  sha256(absolutePath: string): Promise<string>;
  /** ffprobe's duration in seconds; null when the file cannot be read as a video; "no_ffprobe" when ffprobe is not installed. */
  probeDuration(absolutePath: string, bytes: number): Promise<number | null | "no_ffprobe">;
  channel(channelId: string): Promise<ChannelExpectations>;
  /** The channel's synced videos (the local copy). */
  videos(channelId: string): Promise<Array<{ videoId: string; title: string; privacyStatus: string; publishAt: string | null }>>;
  /** BL-243: the copy's videos a sync found removed on YouTube, with when (ISO). Absent: none known. */
  removedVideos?(channelId: string): Promise<Array<{ videoId: string; removedAt: string }>>;
  /** BL-243: when a channel sync last completed the removed check (ISO), or null when never. Absent: null. */
  videosCheckedAt?(channelId: string): Promise<string | null>;
  /** Whether `workspace` is usable now (`local-path-validation`, re-run at use time). */
  validateWorkspace(workspace: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  join(...parts: string[]): string;
  clock: { now(): Date };
};

/** BL-243: the upload record's `uploadedAt` (ISO), when it carries a valid one. */
function uploadedAtOfRecord(text: string): string | null {
  try {
    const value = (JSON.parse(stripBom(text)) as { uploadedAt?: unknown } | null)?.uploadedAt;
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

/** `04 Videos/<MM Month>/<MMDD Vn>/Vn_release.json` (the shared `workspace-videos` walk). */
function findManifests(deps: PackageScanDeps, workspace: string): Promise<string[]> {
  return walkVideosFolder(deps, workspace, (name) => RELEASE_PACKAGE_FILE_PATTERN.test(name));
}

function stateOf(record: { videoId: string } | null, video: { privacyStatus: string; publishAt: string | null } | undefined, removedAt: string | undefined, problems: PackageProblem[], nowMs: number): PackageState {
  if (record) {
    if (removedAt !== undefined) return "deleted_on_youtube";
    if (!video) return "uploaded_unknown";
    if (video.privacyStatus !== "private") return "published";
    const at = video.publishAt ? Date.parse(video.publishAt) : NaN;
    return Number.isFinite(at) && at > nowMs ? "scheduled" : "uploaded_private";
  }
  return problems.length > 0 ? "not_ready" : "ready";
}

/**
 * Review #5 (BL-225): packages naming the same weekly-plan slot. While none of them is uploaded, each is not ready
 * (`slot_duplicate`: the Operator fixes the slot ids); once one is uploaded, every other one is (`slot_taken`). BL-243: a package
 * whose video was deleted on YouTube holds no slot and is never marked -- the others are judged as if it were not there. Pure.
 */
export function markSharedSlots(packages: ScannedPackage[]): ScannedPackage[] {
  const bySlot = new Map<string, ScannedPackage[]>();
  for (const p of packages) {
    if (p.state === "deleted_on_youtube") continue;
    const slotId = p.pkg?.slotId;
    if (slotId) bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), p]);
  }
  const marks = new Map<ScannedPackage, string>();
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const uploaded = group.some((p) => p.youtube !== null);
    for (const p of group) if (p.youtube === null) marks.set(p, uploaded ? "slot_taken" : "slot_duplicate");
  }
  return packages.map((p) => {
    const code = marks.get(p);
    if (!code) return p;
    return { ...p, state: "not_ready" as const, problems: [...p.problems, { code, params: { slotId: p.pkg?.slotId ?? "" } }] };
  });
}

export function createPackageScan(deps: PackageScanDeps) {
  async function readJson(path: string): Promise<unknown> {
    // The factory's text files carry a BOM; JSON.parse does not accept one.
    return JSON.parse(stripBom(await deps.readText(path, MANIFEST_MAX_BYTES)));
  }

  type Copy = { videos: Awaited<ReturnType<PackageScanDeps["videos"]>>; removed: Map<string, string>; checkedAt: string | null };

  async function scanOne(workspace: string, manifestPath: string, channel: ChannelExpectations, copy: Copy): Promise<ScannedPackage | null> {
    const { videos } = copy;
    const manifest = await deps.resolveFile(workspace, manifestPath);
    if (!manifest) return null;
    const folder = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    const base: ScannedPackage = {
      manifestPath,
      folder,
      video: null,
      title: null,
      plannedPublishDate: null,
      thumbnailPath: null,
      testThumbnailPaths: [],
      sizeBytes: null,
      durationSeconds: null,
      state: "not_ready",
      problems: [],
      youtube: null,
      existsOnChannel: null,
      checkedAt: copy.checkedAt,
      pkg: null,
      manifestSha256: await deps.sha256(manifest.path).catch(() => null),
    };
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
    const probed = videoFile ? await deps.probeDuration(videoFile.path, videoFile.bytes) : null;
    const durationSeconds = typeof probed === "number" ? probed : null;
    const thumbnailFile = await deps.resolveFile(workspace, `${folder}/${pkg.files.thumbnail}`);
    const thumbnailKind = thumbnailFile ? imageKindOf(await deps.readHead(thumbnailFile.path, 8)) : null;
    // BL-225 stage 2: every test thumbnail of a v2 package gets the default's checks (exists, JPEG/PNG by content, 2 MB).
    const testThumbnails = [];
    for (const test of (pkg.thumbnails ?? []).filter((t) => t.role === "test")) {
      const file = await deps.resolveFile(workspace, `${folder}/${test.file}`);
      testThumbnails.push({ file: test.file, exists: file !== null, sizeBytes: file?.bytes ?? null, kind: file ? imageKindOf(await deps.readHead(file.path, 8)) : null });
    }
    const recordFile = await deps.resolveFile(workspace, `${folder}/${youtubeRecordFileName(pkg.video)}`);
    let record: { videoId: string } | null = null;
    // BL-243: when the record says the upload happened (`uploadedAt`), so the newest of two deleted uploads speaks for a slot.
    let uploadedAt: string | null = null;
    if (recordFile) {
      const text = await deps.readText(recordFile.path, MANIFEST_MAX_BYTES).catch(() => null);
      record = text === null ? null : parseUploadRecord(text);
      if (record && text !== null) uploadedAt = uploadedAtOfRecord(text);
    }
    const sameTitle = videos.find((video) => video.title === pkg.title);
    const problems = packageProblems(
      pkg,
      {
        video: { exists: videoFile !== null, sizeBytes: videoFile?.bytes ?? null, durationSeconds, probeFailed: videoFile !== null && probed === null, noProbe: probed === "no_ffprobe" },
        thumbnail: { exists: thumbnailFile !== null, sizeBytes: thumbnailFile?.bytes ?? null, kind: thumbnailKind },
        testThumbnails,
        youtubeRecordExists: recordFile !== null,
        sameTitleVideoId: sameTitle?.videoId ?? null,
      },
      channel
    );
    if (recordFile && !record) problems.push({ code: "youtube_record_invalid" });
    const uploaded = record ? videos.find((video) => video.videoId === record.videoId) : undefined;
    // BL-243: the sync's removed mark wins (the stale row's privacy and date say nothing any more).
    const removedAt = record ? copy.removed.get(record.videoId) : undefined;
    const state = stateOf(record, uploaded, removedAt, problems, deps.clock.now().getTime());
    return {
      ...base,
      video: pkg.video,
      title: pkg.title,
      plannedPublishDate: pkg.plannedPublishDate,
      thumbnailPath: thumbnailFile ? `${folder}/${pkg.files.thumbnail}` : null,
      testThumbnailPaths: testThumbnails.filter((t) => t.exists).map((t) => `${folder}/${t.file}`),
      sizeBytes: pkg.sizeBytes,
      durationSeconds: pkg.durationSeconds,
      state,
      problems: state === "deleted_on_youtube" ? [{ code: VIDEO_DELETED_ON_YOUTUBE }] : record ? [] : problems,
      youtube: record
        ? removedAt !== undefined
          ? { videoId: record.videoId, privacyStatus: null, publishAt: null, removedAt, uploadedAt }
          : { videoId: record.videoId, privacyStatus: uploaded?.privacyStatus ?? null, publishAt: uploaded?.publishAt ?? null, removedAt: null, uploadedAt }
        : null,
      // BL-243 review: "on the channel" only as of a removed check that ran (checkedAt); a removed mark is proof on its own.
      existsOnChannel: !record ? null : removedAt !== undefined ? false : uploaded && copy.checkedAt !== null ? true : null,
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
      const [channel, videos, removed, checkedAt, manifests] = await Promise.all([
        deps.channel(channelId),
        deps.videos(channelId),
        // BL-243 (ADR 0063): an unreadable mark is "none known" (such packages read as before) and an unreadable sync time null --
        // never a failed scan.
        deps.removedVideos ? deps.removedVideos(channelId).catch(() => []) : Promise.resolve([]),
        deps.videosCheckedAt ? deps.videosCheckedAt(channelId).catch(() => null) : Promise.resolve(null),
        findManifests(deps, workspace),
      ]);
      const copy: Copy = { videos, removed: new Map(removed.map((video) => [video.videoId, video.removedAt])), checkedAt };
      const packages: ScannedPackage[] = [];
      for (const manifestPath of manifests) {
        const scanned = await scanOne(workspace, manifestPath, channel, copy);
        if (scanned) packages.push(scanned);
      }
      const number = (p: ScannedPackage) => Number(/\d+/.exec(p.video ?? p.manifestPath.split("/").pop() ?? "")?.[0] ?? 0);
      packages.sort((a, b) => (a.plannedPublishDate ?? "9999") .localeCompare(b.plannedPublishDate ?? "9999") || number(a) - number(b));
      return { status: "ok", packages: markSharedSlots(packages), removedVideoIds: [...copy.removed.keys()] };
    },
  };
}

export type PackageScan = ReturnType<typeof createPackageScan>;
