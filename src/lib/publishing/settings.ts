// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; FO-REQ-0023 §4 A3): a channel's publishing defaults -- what every upload
// of the channel gets unless the package says otherwise. Owner msg 2715: "В основном у нас только описание и заголовок меняются
// (плюс thumbnail). Остальные же параметры достаточно выбрать один раз как дефолтные." Owner msgs 2725/2727: the publish time is
// set in UTC, 12:00 by default. Pure: the fields, their defaults and their validation, shared by the routes and the Content panel.
// The values travel between computers in the sync-gateway `channel-publishing-settings` family, which knows nothing of them.
import { isValidLocalTimeOfDay } from "@/lib/zoned-time";

export const PUBLISHING_SETTING_FIELDS = [
  "publishTimeUtc",
  "playlistId",
  "categoryId",
  "madeForKids",
  "containsSyntheticMedia",
  "license",
  "embeddable",
  "notifySubscribers",
] as const;
export type PublishingSettingField = (typeof PUBLISHING_SETTING_FIELDS)[number];

/** `status.license` (YouTube Data API videos resource): the standard YouTube license or Creative Commons. */
export const PUBLISHING_LICENSES = ["youtube", "creativeCommon"] as const;
export type PublishingLicense = (typeof PUBLISHING_LICENSES)[number];

/**
 * The video categories a video can be assigned to (videoCategories.list `assignable: true`; the ids are stable): Film &
 * Animation, Autos & Vehicles, Music, Pets & Animals, Sports, Travel & Events, Gaming, People & Blogs, Comedy, Entertainment,
 * News & Politics, Howto & Style, Education, Science & Technology, Nonprofits & Activism.
 */
export const VIDEO_CATEGORY_IDS = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28", "29"] as const;

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
};

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
};

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
      return typeof value === "boolean" ? null : `${field} must be true or false`;
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
