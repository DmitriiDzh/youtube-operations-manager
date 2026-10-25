// ---------------------------------------------------------------------------
// BL-223 (docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md, ADR 0050): the channel branding draft -- its shape, the documented limits and
// the pure checks (no server code: the Web card imports this file for the same limits and counters). Limits from the official Data
// API v3 reference (the plan's "API facts"):
// - `brandingSettings.channel.description`: "a maximum length of 1000 characters";
// - `brandingSettings.channel.keywords`: "a space-separated list of strings", truncated past "500 characters or if they contained
//   unescaped quotation marks" -- a keyword with a space is written in double quotes here, and a keyword with `"` is refused;
// - `channelBanners.insert`: "16:9 aspect ratio and be at least 2048x1152 pixels", "Maximum file size: 6MB", jpeg or png.
// ---------------------------------------------------------------------------

export const CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS = 1000;
export const CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS = 500;
export const CHANNEL_BANNER_MAX_BYTES = 6 * 1024 * 1024;
export const CHANNEL_BANNER_MIN_WIDTH = 2048;
export const CHANNEL_BANNER_MIN_HEIGHT = 1152;

export type ChannelBannerMimeType = "image/jpeg" | "image/png";

/** The stored banner's facts (its bytes live in the app data folder; `sha256` proves them unchanged at apply). */
export type ChannelBannerMeta = { sha256: string; bytes: number; width: number; height: number; mimeType: ChannelBannerMimeType };

/** The stored draft: each field optional -- absent means "leave as it is on YouTube"; "" / [] clears the field. */
export type ChannelBrandingDraft = {
  description?: string;
  keywords?: string[];
  banner?: ChannelBannerMeta;
};

export type ChannelBrandingField = "description" | "keywords" | "banner";

export type ChannelBrandingRefusalReason =
  | "not_a_string"
  | "description_too_long"
  | "description_angle_brackets"
  | "keywords_not_a_list"
  | "keyword_empty"
  | "keyword_quote"
  | "keywords_too_long"
  | "banner_path_invalid"
  | "banner_unavailable"
  | "banner_not_jpeg_or_png"
  | "banner_unreadable"
  | "banner_too_large"
  | "banner_too_small"
  | "banner_not_16_9"
  | "banner_exif_rotated";

export type ChannelBrandingRefusal = { field: ChannelBrandingField; reason: ChannelBrandingRefusalReason; message: string };

/** Characters as the API counts them (code points), the line breaks as `\n`. */
export function characterCount(value: string): number {
  return [...value].length;
}

export function normalizeDescription(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** The keywords as YouTube stores them: space-separated, a keyword with a space in double quotes. */
export function serializeKeywords(keywords: readonly string[]): string {
  return keywords.map((keyword) => (/\s/.test(keyword) ? `"${keyword}"` : keyword)).join(" ");
}

/** The keyword list of a stored keywords string (a quoted run is one keyword). */
export function parseKeywords(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/g)) {
    const keyword = (match[1] ?? match[2] ?? "").trim();
    if (keyword) out.push(keyword);
  }
  return out;
}

/** The keywords a person types: one per comma or line, trimmed, empties dropped. */
export function keywordsFromText(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((keyword) => keyword.trim().replace(/\s+/g, " "))
    .filter((keyword) => keyword.length > 0);
}

export function validateDescription(input: unknown): { value: string } | { refusal: ChannelBrandingRefusal } {
  if (typeof input !== "string") return { refusal: { field: "description", reason: "not_a_string", message: "description must be a string" } };
  const value = normalizeDescription(input);
  if (characterCount(value) > CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS) {
    return { refusal: { field: "description", reason: "description_too_long", message: `description is ${characterCount(value)} characters; the limit is ${CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS}` } };
  }
  const brackets = angleBracketCount(value);
  if (brackets > 0) return { refusal: { field: "description", reason: "description_angle_brackets", message: `description must not contain < or > (${brackets} found)` } };
  return { value };
}

export function validateKeywords(input: unknown): { value: string[] } | { refusals: ChannelBrandingRefusal[] } {
  if (!Array.isArray(input)) return { refusals: [{ field: "keywords", reason: "keywords_not_a_list", message: "keywords must be a list of strings" }] };
  const refusals: ChannelBrandingRefusal[] = [];
  const value: string[] = [];
  input.forEach((raw, index) => {
    if (typeof raw !== "string") {
      refusals.push({ field: "keywords", reason: "not_a_string", message: `keyword ${index + 1} is not a string` });
      return;
    }
    const keyword = raw.trim().replace(/\s+/g, " ");
    if (!keyword) refusals.push({ field: "keywords", reason: "keyword_empty", message: `keyword ${index + 1} is empty` });
    else if (keyword.includes('"')) refusals.push({ field: "keywords", reason: "keyword_quote", message: `keyword "${keyword}" contains a quotation mark` });
    else value.push(keyword);
  });
  if (refusals.length === 0) {
    const length = characterCount(serializeKeywords(value));
    if (length > CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS) {
      refusals.push({ field: "keywords", reason: "keywords_too_long", message: `the keywords are ${length} characters with their spaces and quotes; the limit is ${CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS}` });
    }
  }
  return refusals.length > 0 ? { refusals } : { value };
}

/** jpeg / png by the first bytes (never by a name). */
export function bannerKindOf(bytes: Uint8Array): ChannelBannerMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, i) => bytes[i] === byte)) return "image/png";
  return null;
}

/** Width and height from the image header (PNG IHDR, JPEG SOFn); null when the header cannot be read. */
export function imageDimensions(bytes: Uint8Array, kind: ChannelBannerMimeType): { width: number; height: number } | null {
  if (kind === "image/png") {
    if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame header
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 8 >= bytes.length) return null;
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * Review #4: the EXIF Orientation of a JPEG (APP1 "Exif", IFD0 tag 0x0112), null when it has none. A value other than 1 means a
 * viewer rotates or mirrors the stored pixels, so the size read from the frame header is not the size the image looks; how YouTube
 * treats it is not documented, so such a banner is refused (conservative).
 */
export function jpegExifOrientation(bytes: Uint8Array): number | null {
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    const start = i + 4;
    if (marker === 0xe1 && length >= 16 && String.fromCharCode(...bytes.slice(start, start + 6)) === "Exif\0\0") {
      const tiff = start + 6;
      const end = Math.min(i + 2 + length, bytes.length);
      const order = String.fromCharCode(bytes[tiff], bytes[tiff + 1]);
      if (order !== "II" && order !== "MM") return null;
      const little = order === "II";
      const u16 = (at: number) => (at + 1 < end ? (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]) : -1);
      const u32 = (at: number) => (at + 3 < end ? (little ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 2 ** 24 : bytes[at] * 2 ** 24 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])) : -1);
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      if (count < 0) return null;
      for (let n = 0; n < count; n++) {
        const entry = ifd + 2 + n * 12;
        if (entry + 11 >= end) return null;
        if (u16(entry) === 0x0112) return u16(entry + 8);
      }
      return null;
    }
    i += 2 + length;
  }
  return null;
}

/** Review #5: how many `<` / `>` a text holds (the card names them so the owner can remove them). */
export function angleBracketCount(value: string): number {
  return (value.match(/[<>]/g) ?? []).length;
}

/** The banner checks of `channelBanners.insert` (type by content, size, minimum size, exactly 16:9). */
export function checkBannerBytes(bytes: Uint8Array): { meta: Omit<ChannelBannerMeta, "sha256"> } | { refusal: ChannelBrandingRefusal } {
  const refuse = (reason: ChannelBrandingRefusalReason, message: string) => ({ refusal: { field: "banner" as const, reason, message } });
  if (bytes.length > CHANNEL_BANNER_MAX_BYTES) return refuse("banner_too_large", `the banner is ${bytes.length} bytes; the limit is 6 MB (${CHANNEL_BANNER_MAX_BYTES} bytes)`);
  const kind = bannerKindOf(bytes);
  if (!kind) return refuse("banner_not_jpeg_or_png", "the banner must be a JPEG or PNG image (checked by its content)");
  const size = imageDimensions(bytes, kind);
  if (!size || size.width === 0 || size.height === 0) return refuse("banner_unreadable", "the banner's width and height cannot be read");
  if (size.width < CHANNEL_BANNER_MIN_WIDTH || size.height < CHANNEL_BANNER_MIN_HEIGHT) {
    return refuse("banner_too_small", `the banner is ${size.width}×${size.height}; it must be at least ${CHANNEL_BANNER_MIN_WIDTH}×${CHANNEL_BANNER_MIN_HEIGHT}`);
  }
  if (size.width * 9 !== size.height * 16) return refuse("banner_not_16_9", `the banner is ${size.width}×${size.height}; it must be exactly 16:9 (e.g. 2560×1440)`);
  const orientation = kind === "image/jpeg" ? jpegExifOrientation(bytes) : null;
  if (orientation !== null && orientation !== 1) {
    return refuse("banner_exif_rotated", `the JPEG's EXIF orientation is ${orientation} (shown rotated or mirrored); save it without rotation (orientation 1) or as PNG`);
  }
  return { meta: { bytes: bytes.length, width: size.width, height: size.height, mimeType: kind } };
}

/** A banner path an agent gives: relative to `99 Data Exchange/Sent to YTM/`, `/` between folders, no `.`/`..`, not absolute. */
export function isRelativeExchangePath(value: string): boolean {
  if (!value || value.length > 500 || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A stored draft read back (null = none or not a draft). */
export function readStoredDraft(json: string | null | undefined): { ok: true; draft: ChannelBrandingDraft | null } | { ok: false; problem: string } {
  if (!json) return { ok: true, draft: null };
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "the stored draft is not an object" };
    const record = parsed as Record<string, unknown>;
    const draft: ChannelBrandingDraft = {};
    if (record.description !== undefined) {
      const checked = validateDescription(record.description);
      if ("refusal" in checked) return { ok: false, problem: checked.refusal.message };
      draft.description = checked.value;
    }
    if (record.keywords !== undefined) {
      const checked = validateKeywords(record.keywords);
      if ("refusals" in checked) return { ok: false, problem: checked.refusals[0].message };
      draft.keywords = checked.value;
    }
    if (record.banner !== undefined) {
      const banner = record.banner as Record<string, unknown>;
      if (
        !banner ||
        typeof banner.sha256 !== "string" ||
        typeof banner.bytes !== "number" ||
        typeof banner.width !== "number" ||
        typeof banner.height !== "number" ||
        (banner.mimeType !== "image/jpeg" && banner.mimeType !== "image/png")
      ) {
        return { ok: false, problem: "the stored banner record is incomplete" };
      }
      draft.banner = { sha256: banner.sha256, bytes: banner.bytes, width: banner.width, height: banner.height, mimeType: banner.mimeType };
    }
    return { ok: true, draft: Object.keys(draft).length > 0 ? draft : null };
  } catch {
    return { ok: false, problem: "the stored draft is not valid JSON" };
  }
}

export type ChannelBrandingFieldStatus = "new" | "changed" | "unchanged" | "cleared";

/** What a text field of the draft would do to the live value. */
export function textStatus(draft: string, live: string): ChannelBrandingFieldStatus {
  if (draft === live) return "unchanged";
  if (live === "") return "new";
  if (draft === "") return "cleared";
  return "changed";
}

export function sameKeywords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((keyword, i) => keyword === b[i]);
}
