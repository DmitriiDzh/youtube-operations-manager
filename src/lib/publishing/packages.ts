// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 items 1 and 3; FO-REQ-0023 §4 A and B2): the release package the factory writes
// next to a finished video, `<MMDD Vn>/Vn_release.json` (`yt-release-package/1`), checked again here before anything is uploaded.
// Pure: the facts about the files (exists, size, type, duration) are gathered by the scan and passed in. The package is never
// edited; a problem is reported, not fixed.

// The YouTube field limits live in the shared `youtube-video-fields` module (also used by live-streams); re-exported unchanged.
export { DESCRIPTION_MAX_BYTES, imageKindOf, TAGS_MAX_CHARACTERS, tagsLength, THUMBNAIL_MAX_BYTES, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { DESCRIPTION_MAX_BYTES, hasAngleBrackets, TAGS_MAX_CHARACTERS, tagsLength, THUMBNAIL_MAX_BYTES, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { validateLocalizationSet, type LocalizationSetLimits } from "@/lib/shared-localization-set";

export const RELEASE_PACKAGE_SCHEMA = "yt-release-package/1";
/**
 * BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md, ADR 0051; FO-REQ-0040 item 2): `yt-release-package/2`, additive to v1 -- `slotId` (the
 * weekly-plan slot it is for), `localizations` ({ <lang>: { title, description } }), `containsSyntheticMedia` (absent: the channel's
 * setting) and `thumbnails` ([{ file, role: default | test }]: the default is the one uploaded, the tests are kept for Test &
 * Compare in Studio). Everything v1 says stays as it is.
 */
export const RELEASE_PACKAGE_SCHEMA_V2 = "yt-release-package/2";
export const RELEASE_PACKAGE_SCHEMAS: readonly string[] = [RELEASE_PACKAGE_SCHEMA, RELEASE_PACKAGE_SCHEMA_V2];
/** A package's translations are a video's (title 100 characters, description 5000 bytes), at most this many languages. */
export const PACKAGE_LOCALIZATIONS_MAX_LANGUAGES = 50;
const PACKAGE_LOCALIZATION_LIMITS: LocalizationSetLimits = {
  titleMaxCharacters: TITLE_MAX_CHARACTERS,
  description: { max: DESCRIPTION_MAX_BYTES, unit: "bytes" },
  maxLanguages: PACKAGE_LOCALIZATIONS_MAX_LANGUAGES,
};

export type PackageThumbnail = { file: string; role: "default" | "test" };
export const RELEASE_PACKAGE_FILE_PATTERN = /^V\d+_release\.json$/;
/** Written next to the package after an upload (FO-REQ-0023 §4 A2). */
export const youtubeRecordFileName = (video: string) => `${video}_youtube.json`;

/** The package's own duration and ffprobe's may differ by rounding, not by a different file. */
const DURATION_TOLERANCE_SECONDS = 1;
/** YouTube chapters: the first starts at 0:00, at least three, each at least 10 seconds long. */
const CHAPTERS_MIN_COUNT = 3;
const CHAPTER_MIN_SECONDS = 10;

export type ReleasePackage = {
  channelId: string;
  video: string;
  mix: number | null;
  plannedPublishDate: string | null;
  files: { video: string; thumbnail: string };
  sizeBytes: number;
  durationSeconds: number;
  title: string;
  description: string;
  tags: string[];
  defaultLanguage: string;
  defaultAudioLanguage: string;
  ready: boolean;
  problems: string[];
  /**
   * BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md §2): the video file's SHA-256 (lower-case hex), the manifest's optional top-level `sha256`.
   * Null (or absent in an older value) when the manifest has none or it is not 64 hex digits: such a package uploads only on the
   * owner's approval. Never a problem of its own -- a manual upload does not need it.
   */
  sha256?: string | null;
  /** BL-225 stage 2: 1 or 2 (absent in a value stored before: 1). */
  schemaVersion?: 1 | 2;
  /** v2: the weekly-plan slot the package is for, or null. */
  slotId?: string | null;
  /** v2: the translations as written (checked by `packageProblems` with the shared rules), or null. */
  localizations?: Record<string, { title: string; description: string }> | null;
  /** v2: the AI flag the package asks for; null = the channel's setting. */
  containsSyntheticMedia?: boolean | null;
  /** Every thumbnail: v1 -- its one file as the default; v2 -- `thumbnails` (exactly one default, which is `files.thumbnail`). */
  thumbnails?: PackageThumbnail[];
};

/** Why a package cannot be uploaded; `params` fill the interface text (`publishingPackages.problem.<code>`). */
export type PackageProblem = { code: string; params?: Record<string, string | number> };

export type PackageFacts = {
  /** `noProbe`: ffprobe is not installed on this computer, so the duration cannot be checked here. */
  video: { exists: boolean; sizeBytes: number | null; durationSeconds: number | null; probeFailed?: boolean; noProbe?: boolean };
  thumbnail: { exists: boolean; sizeBytes: number | null; kind: "jpeg" | "png" | "other" | null };
  /** BL-225 stage 2: each test thumbnail of a v2 package, by its file (absent: none). */
  testThumbnails?: Array<{ file: string; exists: boolean; sizeBytes: number | null; kind: "jpeg" | "png" | "other" | null }>;
  /** `Vn_youtube.json` exists next to the package: it was uploaded from one of the computers. */
  youtubeRecordExists: boolean;
  /** A video of the channel with exactly this title (the synced list), when no record says it is this package. */
  sameTitleVideoId: string | null;
};

export type ChannelExpectations = {
  channelId: string;
  /** The channel's language baseline (Languages → Language defaults); null when not set. */
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
};

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** A path relative to the package folder that stays inside it: `/` between folders, no absolute path, no "..", no empty part. */
export function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The manifest's own shape (FO-REQ-0023 §4 A). Null with the problems when it is not one. */
export function parseReleasePackage(raw: unknown): { pkg: ReleasePackage | null; problems: PackageProblem[] } {
  if (!isObject(raw)) return { pkg: null, problems: [{ code: "not_a_package" }] };
  if (typeof raw.schema !== "string" || !RELEASE_PACKAGE_SCHEMAS.includes(raw.schema)) return { pkg: null, problems: [{ code: "unknown_schema", params: { schema: String(raw.schema ?? "") } }] };
  const v2 = raw.schema === RELEASE_PACKAGE_SCHEMA_V2;
  const problems: PackageProblem[] = [];
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : (problems.push({ code: "field_invalid", params: { field: key } }), ""));
  const num = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : (problems.push({ code: "field_invalid", params: { field: key } }), 0));
  const channelId = str("channelId");
  const video = str("video");
  if (video && !/^V\d+$/.test(video)) problems.push({ code: "field_invalid", params: { field: "video" } });
  const mix = typeof raw.mix === "number" && Number.isFinite(raw.mix) ? raw.mix : null;
  let plannedPublishDate: string | null = null;
  if (raw.plannedPublishDate !== undefined && raw.plannedPublishDate !== null) {
    if (typeof raw.plannedPublishDate === "string" && isDate(raw.plannedPublishDate)) plannedPublishDate = raw.plannedPublishDate;
    else problems.push({ code: "field_invalid", params: { field: "plannedPublishDate" } });
  }
  const files = isObject(raw.files) ? raw.files : {};
  const fileOf = (key: "video" | "thumbnail") => {
    const value = files[key];
    if (typeof value === "string" && isSafeRelativePath(value)) return value;
    problems.push({ code: "field_invalid", params: { field: `files.${key}` } });
    return "";
  };
  const videoFile = fileOf("video");
  // v2: `thumbnails` names every thumbnail; its one default is the uploaded one (`files.thumbnail`, when also given, must be it).
  const v2Thumbnails = v2 && raw.thumbnails !== undefined ? parseThumbnails(raw.thumbnails, problems) : null;
  const defaultThumbnail = v2Thumbnails?.find((t) => t.role === "default")?.file ?? null;
  // A refused `thumbnails` list is reported once (not again as a missing files.thumbnail).
  const thumbnailFile = v2 && raw.thumbnails !== undefined && files.thumbnail === undefined ? (defaultThumbnail ?? "") : fileOf("thumbnail");
  if (v2Thumbnails !== null && defaultThumbnail !== null && files.thumbnail !== undefined && thumbnailFile !== defaultThumbnail) {
    problems.push({ code: "field_invalid", params: { field: "files.thumbnail" } });
  }
  const sizeBytes = num("sizeBytes");
  const durationSeconds = num("durationSeconds");
  const title = str("title");
  const description = str("description");
  const tags = Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === "string") ? (raw.tags as string[]) : (problems.push({ code: "field_invalid", params: { field: "tags" } }), []);
  const defaultLanguage = str("defaultLanguage");
  const defaultAudioLanguage = str("defaultAudioLanguage");
  const ready = raw.ready === true;
  if (typeof raw.ready !== "boolean") problems.push({ code: "field_invalid", params: { field: "ready" } });
  const factoryProblems = Array.isArray(raw.problems) ? raw.problems.map(String) : [];
  const sha256 = typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/i.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
  // v2 fields (a v1 manifest that happens to carry them is read as v1: they are ignored).
  let slotId: string | null = null;
  let localizations: Record<string, { title: string; description: string }> | null = null;
  let containsSyntheticMedia: boolean | null = null;
  if (v2) {
    if (raw.slotId !== undefined && raw.slotId !== null) {
      if (typeof raw.slotId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.slotId)) slotId = raw.slotId;
      else problems.push({ code: "field_invalid", params: { field: "slotId" } });
    }
    if (raw.localizations !== undefined && raw.localizations !== null) {
      // The shape only; every rule (languages, lengths, < >, never the package's own language) is `packageProblems`'.
      if (isObject(raw.localizations)) localizations = raw.localizations as Record<string, { title: string; description: string }>;
      else problems.push({ code: "field_invalid", params: { field: "localizations" } });
    }
    if (raw.containsSyntheticMedia !== undefined && raw.containsSyntheticMedia !== null) {
      if (typeof raw.containsSyntheticMedia === "boolean") containsSyntheticMedia = raw.containsSyntheticMedia;
      else problems.push({ code: "field_invalid", params: { field: "containsSyntheticMedia" } });
    }
  }
  if (problems.length > 0) return { pkg: null, problems };
  const thumbnails: PackageThumbnail[] = v2Thumbnails ?? [{ file: thumbnailFile, role: "default" }];
  return {
    pkg: {
      channelId,
      video,
      mix,
      plannedPublishDate,
      files: { video: videoFile, thumbnail: thumbnailFile },
      sizeBytes,
      durationSeconds,
      title,
      description,
      tags,
      defaultLanguage,
      defaultAudioLanguage,
      ready,
      problems: factoryProblems,
      sha256,
      schemaVersion: v2 ? 2 : 1,
      slotId,
      localizations,
      containsSyntheticMedia,
      thumbnails,
    },
    problems: [],
  };
}

/** v2 `thumbnails`: a list of { file (inside the folder), role: default | test }, no file twice, exactly one default. */
function parseThumbnails(value: unknown, problems: PackageProblem[]): PackageThumbnail[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push({ code: "field_invalid", params: { field: "thumbnails" } });
    return null;
  }
  const list: PackageThumbnail[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.file !== "string" || !isSafeRelativePath(entry.file) || (entry.role !== "default" && entry.role !== "test") || Object.keys(entry).some((k) => k !== "file" && k !== "role")) {
      problems.push({ code: "field_invalid", params: { field: "thumbnails" } });
      return null;
    }
    list.push({ file: entry.file, role: entry.role });
  }
  if (new Set(list.map((t) => t.file)).size !== list.length) {
    problems.push({ code: "field_invalid", params: { field: "thumbnails" } });
    return null;
  }
  const defaults = list.filter((t) => t.role === "default").length;
  if (defaults !== 1) {
    problems.push({ code: "thumbnails_default_count", params: { count: defaults } });
    return null;
  }
  return list;
}

/** The chapter timestamps of a description: lines that start with m:ss, mm:ss or h:mm:ss. */
export function chapterStarts(description: string): number[] {
  const starts: number[] = [];
  for (const line of description.split(/\r?\n/)) {
    const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?=\s|$)/.exec(line);
    if (!match) continue;
    const [, h, m, s] = match;
    starts.push(Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s));
  }
  return starts;
}

/** YouTube's chapter rules (first at 0:00, at least three, each at least 10 s, in order); none at all is not a problem here. */
export function chapterProblems(description: string, durationSeconds: number | null): PackageProblem[] {
  const starts = chapterStarts(description);
  if (starts.length === 0) return [];
  if (starts[0] !== 0) return [{ code: "chapters_first_not_zero" }];
  if (starts.length < CHAPTERS_MIN_COUNT) return [{ code: "chapters_too_few", params: { count: starts.length } }];
  const ends = [...starts.slice(1), durationSeconds ?? Number.POSITIVE_INFINITY];
  for (let i = 0; i < starts.length; i += 1) {
    if (ends[i] - starts[i] < CHAPTER_MIN_SECONDS) return [{ code: "chapter_too_short", params: { index: i + 1 } }];
  }
  return [];
}

/** Every reason the package cannot be uploaded now (FO-REQ-0023 §4 B2), in the order the owner would fix them. */
export function packageProblems(pkg: ReleasePackage, facts: PackageFacts, channel: ChannelExpectations): PackageProblem[] {
  const problems: PackageProblem[] = [];
  if (pkg.channelId !== channel.channelId) problems.push({ code: "other_channel", params: { channelId: pkg.channelId } });
  if (!pkg.ready || pkg.problems.length > 0) problems.push({ code: "factory_not_ready", params: { problems: pkg.problems.join("; ") } });

  const title = pkg.title.trim();
  if (title === "") problems.push({ code: "title_empty" });
  if ([...pkg.title].length > TITLE_MAX_CHARACTERS) problems.push({ code: "title_too_long", params: { length: [...pkg.title].length, max: TITLE_MAX_CHARACTERS } });
  if (hasAngleBrackets(pkg.title)) problems.push({ code: "title_angle_brackets" });
  const descriptionBytes = new TextEncoder().encode(pkg.description).length;
  if (descriptionBytes > DESCRIPTION_MAX_BYTES) problems.push({ code: "description_too_long", params: { bytes: descriptionBytes, max: DESCRIPTION_MAX_BYTES } });
  if (hasAngleBrackets(pkg.description)) problems.push({ code: "description_angle_brackets" });
  const tags = tagsLength(pkg.tags);
  if (tags > TAGS_MAX_CHARACTERS) problems.push({ code: "tags_too_long", params: { length: tags, max: TAGS_MAX_CHARACTERS } });
  // FO-MSG-0017: the package's tags get the same check as the channel's -- YouTube does not accept < or > in a tag.
  if (pkg.tags.some((tag) => hasAngleBrackets(tag))) problems.push({ code: "tags_angle_brackets" });
  problems.push(...chapterProblems(pkg.description, facts.video.durationSeconds ?? pkg.durationSeconds));

  if (channel.defaultLanguage === null) problems.push({ code: "no_channel_baseline" });
  else if (pkg.defaultLanguage !== channel.defaultLanguage) problems.push({ code: "language_differs", params: { package: pkg.defaultLanguage, channel: channel.defaultLanguage } });
  if (channel.defaultAudioLanguage !== null && pkg.defaultAudioLanguage !== channel.defaultAudioLanguage) {
    problems.push({ code: "audio_language_differs", params: { package: pkg.defaultAudioLanguage, channel: channel.defaultAudioLanguage } });
  }

  if (!facts.video.exists) problems.push({ code: "video_missing", params: { file: pkg.files.video } });
  else {
    if (facts.video.sizeBytes !== pkg.sizeBytes) problems.push({ code: "video_size_differs", params: { actual: facts.video.sizeBytes ?? 0, expected: pkg.sizeBytes } });
    if (facts.video.noProbe) problems.push({ code: "ffprobe_missing" });
    else if (facts.video.probeFailed || facts.video.durationSeconds === null) problems.push({ code: "video_unreadable" });
    else if (Math.abs(facts.video.durationSeconds - pkg.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      problems.push({ code: "video_duration_differs", params: { actual: Math.round(facts.video.durationSeconds), expected: Math.round(pkg.durationSeconds) } });
    }
  }
  if (!facts.thumbnail.exists) problems.push({ code: "thumbnail_missing", params: { file: pkg.files.thumbnail } });
  else {
    if (facts.thumbnail.kind !== "jpeg" && facts.thumbnail.kind !== "png") problems.push({ code: "thumbnail_not_image" });
    if ((facts.thumbnail.sizeBytes ?? 0) > THUMBNAIL_MAX_BYTES) problems.push({ code: "thumbnail_too_large", params: { bytes: facts.thumbnail.sizeBytes ?? 0, max: THUMBNAIL_MAX_BYTES } });
  }
  // BL-225 stage 2: every test thumbnail of a v2 package is held to the same rules as the default (owner msg 3511 answer 4: 2 MB).
  for (const test of facts.testThumbnails ?? []) {
    if (!test.exists) problems.push({ code: "test_thumbnail_missing", params: { file: test.file } });
    else {
      if (test.kind !== "jpeg" && test.kind !== "png") problems.push({ code: "test_thumbnail_not_image", params: { file: test.file } });
      if ((test.sizeBytes ?? 0) > THUMBNAIL_MAX_BYTES) problems.push({ code: "test_thumbnail_too_large", params: { file: test.file, bytes: test.sizeBytes ?? 0, max: THUMBNAIL_MAX_BYTES } });
    }
  }
  // BL-225 stage 2: the translations by the shared rules, with a video's limits; the package's own language is never a translation.
  if (pkg.localizations) {
    const checked = validateLocalizationSet(pkg.localizations, { baselineLanguage: pkg.defaultLanguage || null, limits: PACKAGE_LOCALIZATION_LIMITS, ownText: "the package's own title and description" });
    if (!checked.ok) {
      problems.push({
        code: "localizations_invalid",
        params: { languages: checked.refused.length > 0 ? checked.refused.map((r) => `${r.language} (${r.reason})`).join(", ") : checked.problem },
      });
    }
  }
  if (!facts.youtubeRecordExists && facts.sameTitleVideoId !== null) problems.push({ code: "same_title_on_channel", params: { videoId: facts.sameTitleVideoId } });
  return problems;
}

/**
 * BL-225 stage 3: a ready package's translations as they are sent (the shared rules' own form: titles trimmed, descriptions with LF
 * line breaks), or null when it has none. A set the rules refuse is null too -- such a package is never ready (`packageProblems`).
 */
export function packageLocalizationSet(pkg: Pick<ReleasePackage, "localizations" | "defaultLanguage">): Record<string, { title: string; description: string }> | null {
  if (!pkg.localizations || Object.keys(pkg.localizations).length === 0) return null;
  const checked = validateLocalizationSet(pkg.localizations, { baselineLanguage: pkg.defaultLanguage || null, limits: PACKAGE_LOCALIZATION_LIMITS, ownText: "the package's own title and description" });
  return checked.ok ? checked.set : null;
}
