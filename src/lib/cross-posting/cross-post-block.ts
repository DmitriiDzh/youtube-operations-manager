import { FACEBOOK_REEL, INSTAGRAM_REEL } from "./limits";
import type { SocialNetwork } from "./contracts";

// ---------------------------------------------------------------------------
// BL-252 stage 2 (ADR 0068 amendment 1): the optional `crossPost` block of a `yt-release-package/2` manifest -- which networks
// the slot's video also goes to, with what text and (optionally) at what time of the slot's day. Parsed here, never by the
// publishing module (it ignores unknown keys). Problems are codes, one per finding, so the plan screen can show each.
// ---------------------------------------------------------------------------

export type CrossPostTarget =
  | { network: "instagram"; caption: string; shareToFeed: boolean; at: string | null }
  | { network: "facebook"; title: string | null; description: string; at: string | null };

export type CrossPostProblem = { network: SocialNetwork | null; code: string; params?: Record<string, string | number> };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Hashtags and @mentions as Instagram counts them: a word starting with # or @. */
const countTokens = (text: string, sigil: "#" | "@") => (text.match(new RegExp(`(^|\\s)${sigil}[\\p{L}\\p{N}_.]+`, "gu")) ?? []).length;
const chars = (text: string) => [...text].length;

function parseAt(raw: unknown, network: SocialNetwork, problems: CrossPostProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && AT_PATTERN.test(raw)) return raw;
  problems.push({ network, code: "at_invalid" });
  return null;
}

/** `null` block = the slot posts nowhere else. Unknown networks are a problem (a typo must not silently skip a post). */
export function parseCrossPostBlock(raw: unknown): { targets: CrossPostTarget[]; problems: CrossPostProblem[] } {
  const targets: CrossPostTarget[] = [];
  const problems: CrossPostProblem[] = [];
  if (raw === undefined || raw === null) return { targets, problems };
  if (!isObject(raw)) return { targets, problems: [{ network: null, code: "block_invalid" }] };
  for (const key of Object.keys(raw)) if (key !== "instagram" && key !== "facebook") problems.push({ network: null, code: "network_unknown", params: { network: key } });

  const ig = raw.instagram;
  if (ig !== undefined) {
    if (!isObject(ig) || typeof ig.caption !== "string" || !ig.caption.trim()) problems.push({ network: "instagram", code: "caption_required" });
    else {
      const caption = ig.caption;
      if (chars(caption) > INSTAGRAM_REEL.captionMaxChars) problems.push({ network: "instagram", code: "caption_too_long", params: { max: INSTAGRAM_REEL.captionMaxChars } });
      if (countTokens(caption, "#") > INSTAGRAM_REEL.maxHashtags) problems.push({ network: "instagram", code: "too_many_hashtags", params: { max: INSTAGRAM_REEL.maxHashtags } });
      if (countTokens(caption, "@") > INSTAGRAM_REEL.maxMentions) problems.push({ network: "instagram", code: "too_many_mentions", params: { max: INSTAGRAM_REEL.maxMentions } });
      if (ig.shareToFeed !== undefined && typeof ig.shareToFeed !== "boolean") problems.push({ network: "instagram", code: "field_invalid", params: { field: "shareToFeed" } });
      targets.push({ network: "instagram", caption, shareToFeed: ig.shareToFeed !== false, at: parseAt(ig.at, "instagram", problems) });
    }
  }

  const fb = raw.facebook;
  if (fb !== undefined) {
    if (!isObject(fb) || typeof fb.description !== "string" || !fb.description.trim()) problems.push({ network: "facebook", code: "description_required" });
    else {
      const title = fb.title === undefined || fb.title === null ? null : typeof fb.title === "string" ? fb.title : undefined;
      if (title === undefined) problems.push({ network: "facebook", code: "field_invalid", params: { field: "title" } });
      if (title && chars(title) > FACEBOOK_REEL.titleMaxChars) problems.push({ network: "facebook", code: "title_too_long", params: { max: FACEBOOK_REEL.titleMaxChars } });
      if (chars(fb.description) > FACEBOOK_REEL.descriptionMaxChars) problems.push({ network: "facebook", code: "description_too_long", params: { max: FACEBOOK_REEL.descriptionMaxChars } });
      targets.push({ network: "facebook", title: title ?? null, description: fb.description, at: parseAt(fb.at, "facebook", problems) });
    }
  }
  return { targets, problems };
}

/** The video against each target network's rules (duration, size, 9:16). `null` facts are not judged (unknown is not a pass elsewhere). */
export function videoProblems(targets: CrossPostTarget[], video: { durationSeconds: number | null; sizeBytes: number | null; width: number | null; height: number | null }): CrossPostProblem[] {
  const problems: CrossPostProblem[] = [];
  const vertical = video.width && video.height ? Math.abs(video.width / video.height - 9 / 16) <= 0.02 : null;
  for (const t of targets) {
    const rule = t.network === "instagram" ? INSTAGRAM_REEL : FACEBOOK_REEL;
    if (video.durationSeconds === null || video.width === null || video.height === null) {
      problems.push({ network: t.network, code: "video_unreadable" });
      continue;
    }
    if (video.durationSeconds < rule.minSeconds || video.durationSeconds > rule.maxSeconds) problems.push({ network: t.network, code: "duration_out_of_range", params: { min: rule.minSeconds, max: rule.maxSeconds } });
    if (vertical === false) problems.push({ network: t.network, code: "not_vertical" });
    if (t.network === "instagram" && video.sizeBytes !== null && video.sizeBytes > INSTAGRAM_REEL.maxBytes) problems.push({ network: "instagram", code: "file_too_large", params: { maxMb: 300 } });
  }
  return problems;
}
