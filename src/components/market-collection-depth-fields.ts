import { MAX_VIDEOS_PER_CHANNEL_LIMIT, isValidIsoDate, isValidMaxVideosPerChannel } from "@/lib/market-intelligence/collection-depth";
import type { Translate, UiMessage } from "@/lib/ui-text";

// Shared by the Settings card and the per-channel editor (operator request 2026-10-04). Plain text inputs, never `type="number"`/`type="date"`:
// the native widgets render and parse locale-dependently (see the project's settings-input conventions).
// BL-152: a refusal is a key-based message; the component translates it with `uiMessageText`.

/** Blank = "not set" (null); otherwise a whole number 1..2000. */
export function parseDepthDraft(raw: string): { ok: true; value: number | null } | { ok: false; message: UiMessage } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!isValidMaxVideosPerChannel(value)) return { ok: false, message: { key: "depth.invalidMax", params: { max: String(MAX_VIDEOS_PER_CHANNEL_LIMIT) } } };
  return { ok: true, value };
}

/** Blank = no date; otherwise a real calendar date written YYYY-MM-DD. */
export function parseDateDraft(raw: string): { ok: true; value: string | null } | { ok: false; message: UiMessage } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!isValidIsoDate(text)) return { ok: false, message: { key: "depth.invalidDate" } };
  return { ok: true, value: text };
}

export function describeCompleteReason(t: Translate, reason: "cap" | "date" | "exhausted" | null): string {
  if (reason === "cap") return t("depth.reason.cap");
  if (reason === "date") return t("depth.reason.date");
  if (reason === "exhausted") return t("depth.reason.exhausted");
  return "";
}
