import { MAX_VIDEOS_PER_CHANNEL_LIMIT, isValidIsoDate, isValidMaxVideosPerChannel } from "@/lib/market-intelligence/collection-depth";

// Shared by the Settings card and the per-channel editor (operator request 2026-10-04). Plain text inputs, never `type="number"`/`type="date"`:
// the native widgets render and parse locale-dependently (see the project's settings-input conventions).

/** Blank = "not set" (null); otherwise a whole number 1..2000. */
export function parseDepthDraft(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!isValidMaxVideosPerChannel(value)) return { ok: false, message: `Videos per channel must be a whole number from 1 to ${MAX_VIDEOS_PER_CHANNEL_LIMIT}.` };
  return { ok: true, value };
}

/** Blank = no date; otherwise a real calendar date written YYYY-MM-DD. */
export function parseDateDraft(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!isValidIsoDate(text)) return { ok: false, message: "Earliest publish date must be a real date written YYYY-MM-DD." };
  return { ok: true, value: text };
}

export function describeCompleteReason(reason: "cap" | "date" | "exhausted" | null): string {
  if (reason === "cap") return "reached the video limit";
  if (reason === "date") return "reached the earliest publish date";
  if (reason === "exhausted") return "all of the channel's uploads collected";
  return "";
}
