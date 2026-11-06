// BL-246 (ADR 0065, CLIP_REVIEWS_PLAN.md items 11-12): the pure rules of the owner's comment attachments -- limits, allowed kinds,
// what the first bytes must look like, and the file name. No Node or browser API here: the panel checks a file with the same rules
// before sending it, and the module checks it again on this computer.

export const CLIP_ATTACHMENT_LIMITS = Object.freeze({
  /** Files per decision at most. */
  files: 10,
  /** 50 MiB per file at most. */
  bytes: 52_428_800,
  /** Characters of a name before its extension... */
  baseName: 100,
  /** ...and at most this many bytes of them in UTF-8. */
  baseNameBytes: 200,
  /** The panel sends a file in pieces of at most this many bytes (the proxy keeps only the first 40 MB of a body). */
  pieceBytes: 4 * 1024 * 1024,
  /** A staged upload not used by a decision is removed after this long. */
  stagedHours: 24,
});

export type AttachmentKind = "image" | "pdf" | "text" | "json" | "video";

type KindRule = { mime: string; kind: AttachmentKind; declared: readonly string[] };

/** The allowed extensions (lowercase), the type recorded and served, and the types a browser may declare for them. */
export const CLIP_ATTACHMENT_TYPES: Readonly<Record<string, KindRule>> = Object.freeze({
  ".png": { mime: "image/png", kind: "image", declared: ["image/png"] },
  ".jpg": { mime: "image/jpeg", kind: "image", declared: ["image/jpeg", "image/jpg", "image/pjpeg"] },
  ".jpeg": { mime: "image/jpeg", kind: "image", declared: ["image/jpeg", "image/jpg", "image/pjpeg"] },
  ".webp": { mime: "image/webp", kind: "image", declared: ["image/webp"] },
  ".gif": { mime: "image/gif", kind: "image", declared: ["image/gif"] },
  ".pdf": { mime: "application/pdf", kind: "pdf", declared: ["application/pdf", "application/x-pdf"] },
  ".txt": { mime: "text/plain", kind: "text", declared: ["text/plain"] },
  ".md": { mime: "text/markdown", kind: "text", declared: ["text/markdown", "text/x-markdown", "text/plain"] },
  ".json": { mime: "application/json", kind: "json", declared: ["application/json", "text/json", "text/plain"] },
  ".mp4": { mime: "video/mp4", kind: "video", declared: ["video/mp4", "application/mp4"] },
  ".webm": { mime: "video/webm", kind: "video", declared: ["video/webm", "audio/webm"] },
  ".mov": { mime: "video/quicktime", kind: "video", declared: ["video/quicktime"] },
});

/** What the file input offers (the same list as above). */
export const CLIP_ATTACHMENT_ACCEPT = Object.keys(CLIP_ATTACHMENT_TYPES).join(",");

/** The extension of a name, lowercased, with its dot ("" when none). */
export function attachmentExtensionOf(name: string): string {
  const segment = lastSegment(name).replace(/[. ]+$/u, "");
  const dot = segment.lastIndexOf(".");
  return dot >= 0 ? segment.slice(dot).toLowerCase() : "";
}

/** The rule of an allowed extension, or null. */
export function attachmentRuleOf(name: string): KindRule | null {
  return CLIP_ATTACHMENT_TYPES[attachmentExtensionOf(name)] ?? null;
}

/** Whether the type a browser declared fits the extension. An empty or generic type means "not declared" and fits. */
export function declaredTypeFits(name: string, declared: string): boolean {
  const rule = attachmentRuleOf(name);
  if (!rule) return false;
  const type = declared.split(";")[0].trim().toLowerCase();
  return type === "" || type === "application/octet-stream" || rule.declared.includes(type);
}

/** Why a file cannot be attached, by its name, declared type and size; null when it can be sent. */
export function attachmentRefusalOf(file: { name: string; type: string; size: number }): "type_not_allowed" | "type_mismatch" | "too_large" | "empty" | null {
  if (!attachmentRuleOf(file.name)) return "type_not_allowed";
  if (!declaredTypeFits(file.name, file.type)) return "type_mismatch";
  if (!Number.isSafeInteger(file.size) || file.size < 1) return "empty";
  if (file.size > CLIP_ATTACHMENT_LIMITS.bytes) return "too_large";
  return null;
}

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) => head.length >= at + bytes.length && bytes.every((b, i) => head[at + i] === b);
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const QUICKTIME_ATOMS = ["moov", "mdat", "wide", "free", "skip", "pnot"].map(ascii);

/**
 * Whether the file's first bytes are its extension's kind. Binary kinds by their signature (PNG, JPEG, WebP `RIFF....WEBP`, GIF87a/89a,
 * `%PDF-`, ISO-BMFF `....ftyp` for mp4/mov, a QuickTime atom for mov, EBML `1A 45 DF A3` for WebM). Text kinds have no signature: the
 * caller checks them as text (`textLooksValid`).
 */
export function headMatchesKind(name: string, head: Uint8Array): boolean {
  const ext = attachmentExtensionOf(name);
  switch (ext) {
    case ".png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case ".webp":
      return startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8);
    case ".gif":
      return startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"));
    case ".pdf":
      return startsWith(head, ascii("%PDF-"));
    case ".mp4":
      return startsWith(head, ascii("ftyp"), 4);
    case ".mov":
      return startsWith(head, ascii("ftyp"), 4) || QUICKTIME_ATOMS.some((atom) => startsWith(head, atom, 4));
    case ".webm":
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case ".txt":
    case ".md":
    case ".json":
      return true;
    default:
      return false;
  }
}

/** Whether bytes are UTF-8 text without a NUL; `json` also needs them to parse as JSON (a leading BOM is allowed). */
export function textLooksValid(bytes: Uint8Array, json: boolean): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!json) return true;
  try {
    JSON.parse(text.replace(/^﻿/u, ""));
    return true;
  } catch {
    return false;
  }
}

function lastSegment(name: string): string {
  const parts = name.split(/[/\\]/u);
  return parts[parts.length - 1] ?? "";
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/**
 * A safe file name (CLIP_REVIEWS_PLAN.md item 12): NFC; only the last segment after `/` or `\`; trailing dots and spaces dropped; the
 * extension lowercased; in the rest control characters removed, `< > : " | ? *` turned into `_`, whitespace runs into one space,
 * leading and trailing dots and spaces trimmed, `..`+ runs into one `.`, a Windows device name prefixed with `_`, at most 100
 * characters and 200 UTF-8 bytes; empty → `file-<position>`. The extension must already be allowed (the caller checked).
 */
export function sanitizeAttachmentName(raw: string, position: number): string {
  const segment = lastSegment(raw.normalize("NFC")).replace(/[. ]+$/u, "");
  const ext = attachmentExtensionOf(segment);
  let base = ext ? segment.slice(0, segment.length - ext.length) : segment;
  base = base
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .replace(/\.{2,}/gu, ".");
  if (WINDOWS_DEVICE.test(base)) base = `_${base}`;
  const chars = Array.from(base).slice(0, CLIP_ATTACHMENT_LIMITS.baseName);
  // File systems count bytes (255 per name on APFS / NTFS / ext4): 100 CJK characters would be 300 bytes in UTF-8.
  while (new TextEncoder().encode(chars.join("")).length > CLIP_ATTACHMENT_LIMITS.baseNameBytes) chars.pop();
  base = chars.join("").replace(/[. ]+$/u, "");
  if (!base) base = `file-${position}`;
  return `${base}${ext}`;
}

/**
 * The name of the n-th nameless file pasted from the clipboard: `pasted-<n>.<ext of its type>`; a type not on the list gets no
 * extension (so the file is refused as not allowed, never passed off as a picture -- review).
 */
export function pastedNameOf(n: number, type: string): string {
  const ext = Object.entries(CLIP_ATTACHMENT_TYPES).find(([, rule]) => rule.declared.includes(type.split(";")[0].trim().toLowerCase()))?.[0] ?? "";
  return `pasted-${n}${ext === ".jpeg" ? ".jpg" : ext}`;
}

/**
 * Whether a pasted file needs a name of its own (review): a screenshot comes with none or with the browser's generic `image.<ext>`;
 * a file copied in Finder / Explorer keeps its real name.
 */
export function pastedFileNeedsName(name: string): boolean {
  return !name.trim() || /^image\.[a-z0-9]+$/iu.test(name.trim());
}

/** Names that collide ignoring case (macOS and Windows folders do) get `-2`, `-3`, ... before the extension, in order. */
export function uniqueAttachmentNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const ext = attachmentExtensionOf(name);
    const base = ext ? name.slice(0, name.length - ext.length) : name;
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
