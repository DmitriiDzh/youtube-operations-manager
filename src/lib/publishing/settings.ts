// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; FO-REQ-0023 §4 A3): a channel's publishing defaults -- what every upload
// of the channel gets unless the package says otherwise. Owner msg 2715: "В основном у нас только описание и заголовок меняются
// (плюс thumbnail). Остальные же параметры достаточно выбрать один раз как дефолтные." Owner msgs 2725/2727: the publish time is
// set in UTC, 12:00 by default. Pure: the fields, their defaults and their validation, shared by the routes and the Content panel.
// The values travel between computers in the sync-gateway `channel-publishing-settings` family, which knows nothing of them.
import { isValidLocalTimeOfDay } from "@/lib/zoned-time";
import { tagsLength, VIDEO_CATEGORY_IDS, VIDEO_LICENSES, type VideoLicense } from "@/lib/youtube-video-fields";

export const PUBLISHING_SETTING_FIELDS = [
  "publishTimeUtc",
  "playlistId",
  "categoryId",
  "madeForKids",
  "containsSyntheticMedia",
  "license",
  "embeddable",
  "notifySubscribers",
  // Owner msgs 2751/2753: «Прямая реклама» and the channel's own tags.
  "paidProductPlacement",
  "channelTags",
] as const;
export type PublishingSettingField = (typeof PUBLISHING_SETTING_FIELDS)[number];

/** `status.license` and the assignable categories: the shared `youtube-video-fields` lists, under this module's own names. */
export const PUBLISHING_LICENSES = VIDEO_LICENSES;
export type PublishingLicense = VideoLicense;
export { VIDEO_CATEGORY_IDS };

export type PublishingSettings = {
  /** "HH:MM" in UTC: the time of day a dated upload is scheduled for. */
  publishTimeUtc: string;
  /** A playlist of the channel each upload is added to, or none. */
  playlistId: string | null;
  categoryId: string;
  /** `status.selfDeclaredMadeForKids`. */
  madeForKids: boolean;
  /** `status.containsSyntheticMedia` -- "AI use" (FO-REQ-0023 G2: both channels publish AI music). */
  containsSyntheticMedia: boolean;
  license: PublishingLicense;
  embeddable: boolean;
  /** `notifySubscribers` of videos.insert. */
  notifySubscribers: boolean;
  /**
   * `paidProductPlacementDetails.hasPaidProductPlacement` -- Studio's «Прямая реклама» (paid promotion). The part is accepted on
   * videos.insert, but the docs do not list it as settable: the read-back says whether YouTube kept it.
   */
  paidProductPlacement: boolean;
  /** Tags every upload of the channel gets after the package's own (one tag each; the package's come first, none twice). */
  channelTags: string[];
};

/** The channel's own tags: at most this many, each 1-100 characters without `<`, `>` or a comma. */
export const CHANNEL_TAGS_MAX = 30;

/** What a channel gets until a computer saves its own value (FO-REQ-0023 §4 A3; owner msgs 1114, 2725). */
export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = {
  publishTimeUtc: "12:00",
  playlistId: null,
  categoryId: "10",
  madeForKids: false,
  containsSyntheticMedia: true,
  license: "youtube",
  embeddable: true,
  notifySubscribers: true,
  paidProductPlacement: false,
  channelTags: [],
};

/**
 * The tags an upload sends: the package's, then the channel's own that are not already there (case-insensitive). YouTube counts the
 * whole list against its 500-character limit (`tagsLength`); the approval refuses a package whose list would go over.
 */
export function uploadTags(packageTags: readonly string[], channelTags: readonly string[]): string[] {
  const seen = new Set(packageTags.map((t) => t.toLowerCase()));
  const out = [...packageTags];
  for (const tag of channelTags) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

/** Why `value` is not a valid value of `field`, or null when it is. */
export function publishingSettingProblem(field: PublishingSettingField, value: unknown): string | null {
  switch (field) {
    case "publishTimeUtc":
      return typeof value === "string" && isValidLocalTimeOfDay(value) ? null : "publishTimeUtc must be a 24-hour HH:MM time (UTC)";
    case "playlistId":
      return value === null || (typeof value === "string" && PLAYLIST_ID_PATTERN.test(value)) ? null : "playlistId must be a playlist id or null";
    case "categoryId":
      return typeof value === "string" && (VIDEO_CATEGORY_IDS as readonly string[]).includes(value) ? null : `categoryId must be one of ${VIDEO_CATEGORY_IDS.join(", ")}`;
    case "license":
      return typeof value === "string" && (PUBLISHING_LICENSES as readonly string[]).includes(value) ? null : `license must be one of ${PUBLISHING_LICENSES.join(", ")}`;
    case "madeForKids":
    case "containsSyntheticMedia":
    case "embeddable":
    case "notifySubscribers":
    case "paidProductPlacement":
      return typeof value === "boolean" ? null : `${field} must be true or false`;
    case "channelTags": {
      if (!Array.isArray(value) || value.length > CHANNEL_TAGS_MAX) return `channelTags must be a list of at most ${CHANNEL_TAGS_MAX} tags`;
      const bad = value.find((tag) => typeof tag !== "string" || tag.trim() !== tag || tag.length < 1 || tag.length > 100 || /[<>,]/.test(tag));
      if (bad !== undefined) return "each channel tag is 1-100 characters, without leading or trailing spaces, <, > or a comma";
      if (new Set(value.map((tag: string) => tag.toLowerCase())).size !== value.length) return "a channel tag is listed twice";
      return tagsLength(value as string[]) > 500 ? "the channel tags alone are over YouTube's 500 characters" : null;
    }
  }
}

export function isPublishingSettingField(field: string): field is PublishingSettingField {
  return (PUBLISHING_SETTING_FIELDS as readonly string[]).includes(field);
}

/**
 * The settings in force: each saved value that is valid, otherwise the default. A value this build does not accept (written by a
 * newer build, or damaged) falls back to the default rather than reaching an upload. `saved` names the fields a computer saved.
 */
export function effectivePublishingSettings(stored: Record<string, unknown>): { settings: PublishingSettings; saved: PublishingSettingField[] } {
  const settings: PublishingSettings = { ...DEFAULT_PUBLISHING_SETTINGS };
  const saved: PublishingSettingField[] = [];
  for (const field of PUBLISHING_SETTING_FIELDS) {
    if (!(field in stored) || publishingSettingProblem(field, stored[field]) !== null) continue;
    (settings as Record<PublishingSettingField, unknown>)[field] = stored[field];
    saved.push(field);
  }
  return { settings, saved };
}

/** A save from the Content panel: only known fields, each valid; nothing is accepted when one is not. */
export function parsePublishingSettingsPatch(body: unknown): { ok: true; patch: Partial<PublishingSettings> } | { ok: false; message: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "The body must be an object of publishing settings" };
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(body)) {
    if (!isPublishingSettingField(field)) return { ok: false, message: `Unknown publishing setting "${field}"` };
    const problem = publishingSettingProblem(field, value);
    if (problem) return { ok: false, message: problem };
    patch[field] = value;
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: "No publishing setting to save" };
  return { ok: true, patch: patch as Partial<PublishingSettings> };
}
