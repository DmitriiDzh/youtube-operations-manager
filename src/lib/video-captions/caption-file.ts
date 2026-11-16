// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.1, §3.2; ADR 0074 §3): the caption file checks -- pure, shared by the package scan and the
// writer (which re-checks the very bytes it sends). Only SubRip (.srt) and WebVTT (.vtt), the two formats the Operator writes and
// YouTube accepts (support.google.com/youtube/answer/2734698). Stricter than YouTube on purpose: a file refused here is fixed by the
// factory, never "repaired" by the app.
import { createHash } from "node:crypto";

/** Our cap (the API allows 100 MB; the factory writes at most 1 MB). */
export const CAPTIONS_MAX_BYTES = 10 * 1024 * 1024;
/** `captions.insert`: `nameTooLong` above 150 characters. */
export const CAPTIONS_NAME_MAX_CHARACTERS = 150;
/** A cue may end this long after the video's duration (rounding of the duration). */
export const CAPTIONS_DURATION_TOLERANCE_MS = 1000;
/** The language the writer sends (owner TG 4590: English only). */
export const CAPTIONS_LANGUAGE = "en";
/** What the writer declares the media as (`captions.insert`/`update` accept `application/octet-stream`). */
export const CAPTIONS_MIME_TYPE = "application/octet-stream";

export type CaptionFormat = "srt" | "vtt";
export type CaptionFileCheck = { ok: true; format: CaptionFormat; cues: number; lastEndMs: number } | { ok: false; detail: string };

/** The format a file name declares by its extension, or null when it is neither `.srt` nor `.vtt`. */
export function captionFormatOfName(name: string): CaptionFormat | null {
  const match = /\.(srt|vtt)$/i.exec(name);
  return match ? (match[1].toLowerCase() as CaptionFormat) : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A track's language is English when its primary subtag is `en` (`en`, `en-US`, `en-GB`, ...). */
export function isEnglishLanguage(language: string | null | undefined): boolean {
  return typeof language === "string" && language.split(/[-_]/)[0].toLowerCase() === "en";
}

/** The name rule (ADR 0074 §3): 0–150 characters ("" allowed), no `<` or `>`. */
export function captionNameProblem(name: string): string | null {
  if ([...name].length > CAPTIONS_NAME_MAX_CHARACTERS) return `longer than ${CAPTIONS_NAME_MAX_CHARACTERS} characters`;
  if (/[<>]/.test(name)) return "contains < or >";
  return null;
}

const SRT_TIME = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/;
const VTT_TIME = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

function toMs(match: RegExpExecArray, hoursIndex: number): number {
  const hours = match[hoursIndex] === undefined ? 0 : Number(match[hoursIndex]);
  return ((hours * 60 + Number(match[hoursIndex + 1])) * 60 + Number(match[hoursIndex + 2])) * 1000 + Number(match[hoursIndex + 3]);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The text's blocks (separated by blank lines), each as its lines; line endings LF, CRLF or CR. */
function blocksOf(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * The format check of one caption file: UTF-8 (a BOM tolerated), the extension's format and the content agree, at least one cue,
 * every timestamp valid, every end after its start, no cue ending after `durationSeconds` + 1 s (when the duration is known).
 */
export function checkCaptionFile(bytes: Uint8Array, fileName: string, durationSeconds: number | null): CaptionFileCheck {
  const format = captionFormatOfName(fileName);
  if (!format) return { ok: false, detail: "not a .srt or .vtt file" };
  const decoded = decodeUtf8(bytes);
  if (decoded === null) return { ok: false, detail: "not UTF-8" };
  const text = decoded.replace(/^﻿/, "");
  const isVtt = /^WEBVTT(?:[ \t]|\r|\n|$)/.test(text);
  if (format === "vtt" && !isVtt) return { ok: false, detail: "a .vtt file must start with WEBVTT" };
  if (format === "srt" && isVtt) return { ok: false, detail: "a .srt file holds WebVTT" };
  const blocks = blocksOf(text);
  let cues = 0;
  let lastEndMs = 0;
  const limitMs = durationSeconds !== null && Number.isFinite(durationSeconds) ? durationSeconds * 1000 + CAPTIONS_DURATION_TOLERANCE_MS : null;
  for (const [index, block] of blocks.entries()) {
    let timingLine: string;
    if (format === "vtt") {
      if (index === 0) continue; // the WEBVTT header block
      if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0])) continue;
      // An optional cue identifier before the timing line.
      timingLine = block[0].includes("-->") ? block[0] : (block[1] ?? "");
    } else {
      timingLine = /^\d+$/.test(block[0].trim()) ? (block[1] ?? "") : block[0];
    }
    const parts = /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(timingLine);
    if (!parts) return { ok: false, detail: `cue ${cues + 1}: no timing line` };
    if (format === "srt" && parts[3].trim() !== "") return { ok: false, detail: `cue ${cues + 1}: unexpected text after the end time` };
    const pattern = format === "srt" ? SRT_TIME : VTT_TIME;
    const start = pattern.exec(parts[1]);
    const end = pattern.exec(parts[2]);
    if (!start || !end) return { ok: false, detail: `cue ${cues + 1}: a bad timestamp` };
    const startMs = toMs(start, 1);
    const endMs = toMs(end, 1);
    if (endMs <= startMs) return { ok: false, detail: `cue ${cues + 1}: ends before it starts` };
    if (limitMs !== null && endMs > limitMs) return { ok: false, detail: `cue ${cues + 1}: ends after the video` };
    cues += 1;
    lastEndMs = Math.max(lastEndMs, endMs);
  }
  if (cues === 0) return { ok: false, detail: "no cue" };
  return { ok: true, format, cues, lastEndMs };
}
