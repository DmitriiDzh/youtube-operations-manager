// The limits and fixed value lists of a YouTube video's own fields (YouTube Data API videos resource, thumbnails.set), shared by
// every module that sets them before any write: publishing (release packages, channel defaults) and live-streams (the stream's
// settings, BL-186). Pure, no server code: the Web UI imports it too. One owner for these rules (AGENTS.md §M) -- extracted from
// `publishing/packages.ts` and `publishing/settings.ts` on 2026-10-14, which re-export them unchanged.

/** snippet.title "maximum length of 100 characters ... all valid UTF-8 characters except < and >". */
export const TITLE_MAX_CHARACTERS = 100;
/** snippet.description "maximum length of 5000 bytes ... all valid UTF-8 characters except < and >". */
export const DESCRIPTION_MAX_BYTES = 5000;
/** snippet.tags "maximum length of 500 characters": the commas between tags count, and a tag with a space counts its quotes. */
export const TAGS_MAX_CHARACTERS = 500;
/** One tag: Studio's own limit (a longer one is refused there); the API counts it inside the 500 above. */
export const TAG_MAX_CHARACTERS = 100;
/** thumbnails.set: "Maximum file size: 2MB", image/jpeg or image/png. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** `status.license`: the standard YouTube license or Creative Commons. */
export const VIDEO_LICENSES = ["youtube", "creativeCommon"] as const;
export type VideoLicense = (typeof VIDEO_LICENSES)[number];

/**
 * The video categories a video can be assigned to (videoCategories.list `assignable: true`; the ids are stable): Film &
 * Animation, Autos & Vehicles, Music, Pets & Animals, Sports, Travel & Events, Gaming, People & Blogs, Comedy, Entertainment,
 * News & Politics, Howto & Style, Education, Science & Technology, Nonprofits & Activism.
 */
export const VIDEO_CATEGORY_IDS = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28", "29"] as const;

/** Whether a text holds `<` or `>`, which YouTube refuses in a title, a description and a tag (BL-207: moved here from
 * `publishing/packages.ts` so the live translations validator applies the same rule). */
export function hasAngleBrackets(text: string): boolean {
  return /[<>]/.test(text);
}

/** snippet.tags as YouTube counts it: each tag, its quotes when it has a space, and a comma between tags. */
export function tagsLength(tags: readonly string[]): number {
  if (tags.length === 0) return 0;
  return tags.reduce((sum, tag) => sum + [...tag].length + (/\s/.test(tag) ? 2 : 0), 0) + (tags.length - 1);
}

/** JPEG starts with FF D8 FF; PNG with 89 50 4E 47 0D 0A 1A 0A. */
export function imageKindOf(head: Uint8Array): "jpeg" | "png" | "other" {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((byte, i) => head[i] === byte)) return "png";
  return "other";
}
