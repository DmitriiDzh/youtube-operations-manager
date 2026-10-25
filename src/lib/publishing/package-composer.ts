import { z } from "zod";
import { DomainError, type DomainErrorCode } from "@/lib/shared-domain";
import { isNamedAfterRelease, isVideoFileName, stripBom, VIDEOS_FOLDER, videoNumberOfFolder, walkVideosFolder, type DirEntry } from "@/lib/workspace-videos";
import {
  imageKindOf,
  isSafeRelativePath,
  packageProblems,
  RELEASE_PACKAGE_FILE_PATTERN,
  RELEASE_PACKAGE_SCHEMA,
  THUMBNAIL_MAX_BYTES,
  youtubeRecordFileName,
  type ChannelExpectations,
  type PackageProblem,
  type ReleasePackage,
} from "./packages";

// BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md): a release package the owner makes in Content → «Публикация» from what
// a video folder already holds (the video, `Thumbnail_*`, `*Title_Description*.txt`), written as the same `Vn_release.json`
// (`yt-release-package/1`) the Operator writes. The upload itself is unchanged: the package still needs the owner's approval.

/** The text file the factory keeps next to a video: `TITLE` / the title / `DESCRIPTION` / the description. */
export const TITLE_DESCRIPTION_FILE_PATTERN = /title_description.*\.txt$/i;
const IMAGE_FILE_PATTERN = /\.(jpe?g|png)$/i;
const TEXT_MAX_BYTES = 256 * 1024;

/** Title and description from a `*Title_Description*.txt`; null without a `TITLE` or a `DESCRIPTION` line (AC-NP-01). */
export function parseTitleDescription(text: string): { title: string; description: string } | null {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const titleAt = lines.findIndex((line) => line.trim().toUpperCase() === "TITLE");
  const descriptionAt = lines.findIndex((line, index) => index > titleAt && line.trim().toUpperCase() === "DESCRIPTION");
  if (titleAt < 0 || descriptionAt < 0) return null;
  const title = lines
    .slice(titleAt + 1, descriptionAt)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  const description = lines
    .slice(descriptionAt + 1)
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
  return { title, description };
}

/** What a folder offers, by kind; each a direct child of the folder (AC-NP-02). */
export type FolderFiles = { videos: string[]; images: string[]; texts: string[]; manifest: string | null; youtubeRecord: string | null };

/** The default picks: the one candidate of each kind, else null (the owner picks). */
export function defaultPicks(video: string, files: FolderFiles): { video: string | null; thumbnail: string | null; text: string | null } {
  const only = (list: string[]) => (list.length === 1 ? list[0] : null);
  const named = files.videos.filter((name) => isNamedAfterRelease(name, video));
  const thumbnails = files.images.filter((name) => /^thumbnail/i.test(name));
  return {
    video: only(files.videos) ?? only(named),
    thumbnail: thumbnails.length > 0 ? only(thumbnails) : only(files.images),
    text: only(files.texts),
  };
}

export type ComposerFolder = {
  /** `04 Videos/<month>/<MMDD Vn>`, relative to the workspace. */
  folder: string;
  video: string;
  files: FolderFiles;
  /** A package is there already. */
  hasPackage: boolean;
};

export type DraftInput = {
  folder: string;
  files?: { video?: string | null; thumbnail?: string | null; text?: string | null };
  title?: string;
  description?: string;
  tags?: string[];
  plannedPublishDate?: string | null;
};

export type PackageDraft = {
  folder: string;
  video: string;
  files: FolderFiles;
  picks: { video: string | null; thumbnail: string | null; text: string | null };
  title: string;
  description: string;
  /** The text file had no `TITLE` / `DESCRIPTION` lines (or could not be read). */
  textUnreadable: boolean;
  tags: string[];
  plannedPublishDate: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  languages: { defaultLanguage: string | null; defaultAudioLanguage: string | null };
  /** What the scan would say about this package (the same checks as before an upload). */
  problems: PackageProblem[];
  existing: { exists: boolean; replaceable: boolean; reason: "uploaded" | "queued" | null };
};

export type ComposerDeps = {
  workspace(channelId: string): Promise<string | null>;
  validateWorkspace(workspace: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  listDir(absolutePath: string): Promise<DirEntry[]>;
  resolveFile(workspace: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
  readText(absolutePath: string, maxBytes: number): Promise<string>;
  readHead(absolutePath: string, bytes: number): Promise<Uint8Array>;
  probeDuration(absolutePath: string, bytes: number): Promise<number | null | "no_ffprobe">;
  channel(channelId: string): Promise<ChannelExpectations>;
  videos(channelId: string): Promise<Array<{ videoId: string; title: string }>>;
  /** The release numbers held by an upload here (queued, running, done) or reported by another computer (the approval's rule). */
  heldVideos(channelId: string): Promise<Set<string>>;
  /** Whether the folder's real path (symlinks resolved) is strictly inside the workspace's real `04 Videos/`. */
  isVideoFolder(workspace: string, folder: string): Promise<boolean>;
  /** Writes `<folder>/<name>` whole or not at all; the folder's real path must be inside the workspace. */
  writeManifest(workspace: string, folder: string, name: string, text: string): Promise<void>;
  join(...parts: string[]): string;
};

const fileName = z.string().min(1).max(255).nullable().optional();
/** The body of a draft or a save: unknown keys refused. */
export const packageComposerInputSchema = z
  .object({
    folder: z.string().min(1).max(1024),
    files: z.object({ video: fileName, thumbnail: fileName, text: fileName }).strict().optional(),
    title: z.string().max(10_000).optional(),
    description: z.string().max(100_000).optional(),
    tags: z.array(z.string().max(500)).max(500).optional(),
    plannedPublishDate: z.string().nullable().optional(),
    replace: z.boolean().optional(),
  })
  .strict();

function parseInput(input: unknown): DraftInput & { replace?: boolean } {
  const parsed = packageComposerInputSchema.safeParse(input);
  if (!parsed.success) throw refuse("validation_failed", "The package fields are not valid.", { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  return parsed.data;
}

const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function createPackageComposer(deps: ComposerDeps) {
  async function usableWorkspace(channelId: string): Promise<string> {
    const workspace = await deps.workspace(channelId);
    if (!workspace) throw refuse("package_no_workspace", "This channel has no workspace folder on this computer (Settings → Channels).");
    const validation = await deps.validateWorkspace(workspace);
    if (!validation.ok) throw refuse("package_workspace_unavailable", `The workspace cannot be used: ${validation.reason}`);
    return workspace;
  }

  /** `04 Videos/<month>/<MMDD Vn>` exactly, with a safe path, whose real folder is inside the real `04 Videos/`; its release number. */
  async function checkedRelease(workspace: string, folder: string): Promise<string> {
    const video = releaseOf(folder);
    if (!(await deps.isVideoFolder(workspace, folder))) throw refuse("package_folder_invalid", `${folder} is not a video folder of this channel.`, { folder });
    return video;
  }

  function releaseOf(folder: string): string {
    const parts = folder.split("/");
    const video = parts.length === 3 && parts[0] === VIDEOS_FOLDER && isSafeRelativePath(folder) ? videoNumberOfFolder(parts[2]) : null;
    if (!video) throw refuse("package_folder_invalid", `${folder} is not a video folder (04 Videos/<month>/<MMDD Vn>).`, { folder });
    return video;
  }

  async function filesOf(workspace: string, folder: string, video: string): Promise<FolderFiles> {
    const entries = (await deps.listDir(deps.join(workspace, ...folder.split("/")))).filter((entry) => entry.kind === "file" && !entry.name.startsWith("."));
    const names = entries.map((entry) => entry.name).sort();
    return {
      videos: names.filter(isVideoFileName),
      images: names.filter((name) => IMAGE_FILE_PATTERN.test(name)),
      texts: names.filter((name) => TITLE_DESCRIPTION_FILE_PATTERN.test(name)),
      manifest: names.find((name) => name === `${video}_release.json`) ?? null,
      youtubeRecord: names.find((name) => name === youtubeRecordFileName(video)) ?? null,
    };
  }

  async function existingOf(channelId: string, video: string, files: FolderFiles): Promise<PackageDraft["existing"]> {
    if (files.youtubeRecord) return { exists: files.manifest !== null, replaceable: false, reason: "uploaded" };
    if ((await deps.heldVideos(channelId)).has(video)) return { exists: files.manifest !== null, replaceable: false, reason: "queued" };
    return { exists: files.manifest !== null, replaceable: true, reason: null };
  }

  /** The chosen file of a kind: a direct child of the folder named in the folder's list of that kind; null when none. */
  function chosen(kind: keyof Pick<FolderFiles, "videos" | "images" | "texts">, files: FolderFiles, name: string | null | undefined, fallback: string | null): string | null {
    if (name === undefined) return fallback;
    if (name === null) return null;
    if (!files[kind].includes(name)) throw refuse("package_file_invalid", `${name} is not a ${kind.slice(0, -1)} file of this folder.`, { file: name });
    return name;
  }

  async function build(channelId: string, input: DraftInput) {
    const workspace = await usableWorkspace(channelId);
    const video = await checkedRelease(workspace, input.folder);
    const files = await filesOf(workspace, input.folder, video);
    if (files.videos.length === 0) throw refuse("package_no_video", `${input.folder} holds no video file.`, { folder: input.folder });
    const defaults = defaultPicks(video, files);
    const picks = {
      video: chosen("videos", files, input.files?.video, defaults.video),
      thumbnail: chosen("images", files, input.files?.thumbnail, defaults.thumbnail),
      text: chosen("texts", files, input.files?.text, defaults.text),
    };
    let fromText: { title: string; description: string } | null = null;
    let textUnreadable = false;
    if (picks.text) {
      const textFile = await deps.resolveFile(workspace, `${input.folder}/${picks.text}`);
      fromText = textFile ? await deps.readText(textFile.path, TEXT_MAX_BYTES).then(parseTitleDescription, () => null) : null;
      textUnreadable = fromText === null;
    }
    // Trimmed like the text file's lines (review of BL-192): YouTube trims a title, and the upload compares the read-back with it.
    const title = (input.title ?? fromText?.title ?? "").trim();
    const description = input.description ?? fromText?.description ?? "";
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw refuse("validation_failed", "tags must be a list of strings.", { field: "tags" });
    const plannedPublishDate = input.plannedPublishDate ?? null;
    if (plannedPublishDate !== null && (typeof plannedPublishDate !== "string" || !isDate(plannedPublishDate))) {
      throw refuse("validation_failed", "plannedPublishDate must be a real date (YYYY-MM-DD).", { field: "plannedPublishDate" });
    }

    const videoFile = picks.video ? await deps.resolveFile(workspace, `${input.folder}/${picks.video}`) : null;
    const probed = videoFile ? await deps.probeDuration(videoFile.path, videoFile.bytes) : null;
    const durationSeconds = typeof probed === "number" ? probed : null;
    const thumbnailFile = picks.thumbnail ? await deps.resolveFile(workspace, `${input.folder}/${picks.thumbnail}`) : null;
    const thumbnailKind = thumbnailFile ? imageKindOf(await deps.readHead(thumbnailFile.path, 8)) : null;
    const [channel, videos] = await Promise.all([deps.channel(channelId), deps.videos(channelId)]);
    const pkg: ReleasePackage = {
      channelId,
      video,
      mix: null,
      plannedPublishDate,
      files: { video: picks.video ?? "", thumbnail: picks.thumbnail ?? "" },
      sizeBytes: videoFile?.bytes ?? 0,
      durationSeconds: durationSeconds ?? 0,
      title,
      description,
      tags,
      defaultLanguage: channel.defaultLanguage ?? "",
      // Never invented (review of BL-192): the upload sends exactly this value, so without an audio baseline the save is refused.
      defaultAudioLanguage: channel.defaultAudioLanguage ?? "",
      ready: true,
      problems: [],
    };
    const problems = packageProblems(
      pkg,
      {
        video: { exists: videoFile !== null, sizeBytes: videoFile?.bytes ?? null, durationSeconds, probeFailed: videoFile !== null && probed === null, noProbe: probed === "no_ffprobe" },
        thumbnail: { exists: thumbnailFile !== null, sizeBytes: thumbnailFile?.bytes ?? null, kind: thumbnailKind },
        youtubeRecordExists: files.youtubeRecord !== null,
        sameTitleVideoId: videos.find((v) => v.title === title)?.videoId ?? null,
      },
      channel
    );
    const draft: PackageDraft = {
      folder: input.folder,
      video,
      files,
      picks,
      title,
      description,
      textUnreadable,
      tags,
      plannedPublishDate,
      sizeBytes: videoFile?.bytes ?? null,
      durationSeconds,
      languages: { defaultLanguage: channel.defaultLanguage, defaultAudioLanguage: channel.defaultAudioLanguage },
      problems,
      existing: await existingOf(channelId, video, files),
    };
    return { workspace, pkg, draft, channel };
  }

  return {
    /** Every `04 Videos/<month>/<MMDD Vn>` folder holding a video file directly inside, newest first. */
    async listFolders(channelId: string): Promise<ComposerFolder[]> {
      const workspace = await usableWorkspace(channelId);
      const videoFiles = await walkVideosFolder(deps, workspace, isVideoFileName);
      const folders = [...new Set(videoFiles.map((file) => file.slice(0, file.lastIndexOf("/"))))].filter((folder) => {
        const parts = folder.split("/");
        return parts.length === 3 && videoNumberOfFolder(parts[2]) !== null;
      });
      const result: ComposerFolder[] = [];
      for (const folder of folders) {
        const video = videoNumberOfFolder(folder.split("/")[2]) as string;
        const files = await filesOf(workspace, folder, video);
        result.push({ folder, video, files, hasPackage: files.manifest !== null });
      }
      return result.sort((a, b) => b.folder.localeCompare(a.folder));
    },

    /** The package as it would be saved from `input` (the folder's own files and text unless the owner changed them), with its problems. */
    async draft(channelId: string, input: unknown): Promise<PackageDraft> {
      return (await build(channelId, parseInput(input))).draft;
    },

    /**
     * Writes `<folder>/Vn_release.json` from `input`, every fact (size, duration, languages, Vn) taken again here. Refused, with nothing
     * written: no video or thumbnail chosen, a video whose length ffprobe cannot read, no channel language baseline, an empty title, an existing package without `replace`, and
     * one that is uploaded or held by an upload here or on another computer even with it (AC-NP-04/05). Problems that the scan reports
     * (e.g. chapters) do not refuse: the package is saved and shows as not ready with them.
     */
    async save(channelId: string, raw: unknown): Promise<PackageDraft> {
      const input = parseInput(raw);
      const { workspace, pkg, draft, channel } = await build(channelId, input);
      if (!draft.picks.video) throw refuse("package_no_video", "Choose the video file.", { folder: input.folder });
      if (!draft.picks.thumbnail) throw refuse("package_no_thumbnail", "Choose the thumbnail.", { folder: input.folder });
      // BL-225 stage 2 (owner msg 3511 answer 4): the 2 MB limit and the image type are enforced when the package is made, not only
      // reported by the scan afterwards.
      if (draft.problems.some((p) => p.code === "thumbnail_too_large")) throw refuse("package_thumbnail_too_large", "The thumbnail is larger than 2 MB.", { folder: input.folder, file: draft.picks.thumbnail, max: THUMBNAIL_MAX_BYTES });
      if (draft.problems.some((p) => p.code === "thumbnail_not_image")) throw refuse("package_thumbnail_not_image", "The thumbnail is neither JPEG nor PNG.", { folder: input.folder, file: draft.picks.thumbnail });
      if (draft.durationSeconds === null) throw refuse("package_duration_unknown", "The video's length could not be read (is ffprobe installed?).", { folder: input.folder });
      if (channel.defaultLanguage === null || channel.defaultAudioLanguage === null) {
        throw refuse("package_no_baseline", "The channel has no language or audio-language baseline (Languages → Language defaults).");
      }
      if (pkg.title.trim() === "") throw refuse("package_title_empty", "The title is empty.");
      if (draft.existing.exists && !input.replace) throw refuse("package_exists", `${pkg.video}_release.json is there already.`, { video: pkg.video });
      if (!draft.existing.replaceable) throw refuse("package_held", `${pkg.video} is already uploaded or queued: its package cannot be changed.`, { video: pkg.video, reason: draft.existing.reason });
      const name = `${pkg.video}_release.json`;
      if (!RELEASE_PACKAGE_FILE_PATTERN.test(name)) throw refuse("package_folder_invalid", `${name} is not a package name.`);
      const manifest = {
        schema: RELEASE_PACKAGE_SCHEMA,
        channelId: pkg.channelId,
        video: pkg.video,
        mix: null,
        plannedPublishDate: pkg.plannedPublishDate,
        files: pkg.files,
        sizeBytes: pkg.sizeBytes,
        durationSeconds: pkg.durationSeconds,
        title: pkg.title,
        description: pkg.description,
        tags: pkg.tags,
        defaultLanguage: pkg.defaultLanguage,
        defaultAudioLanguage: pkg.defaultAudioLanguage,
        ready: true,
        problems: [],
        createdBy: "owner",
      };
      await deps.writeManifest(workspace, input.folder, name, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ...draft, files: { ...draft.files, manifest: name }, existing: { exists: true, replaceable: true, reason: null } };
    },
  };
}

export type PackageComposer = ReturnType<typeof createPackageComposer>;
