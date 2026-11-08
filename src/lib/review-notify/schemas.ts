import path from "node:path";
import { z } from "zod";
import { DEFAULT_REVIEW_NOTIFY_SETTINGS, INITIAL_REVIEW_NOTIFY_STATE, type ReviewNotifySettings, type ReviewNotifyState } from "./contracts";

// BL-248: the owner's settings input, and the stored settings / state read defensively (a damaged row reads as the default).

const inboxPathSchema = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null || value.trim() === "" ? null : value.trim()))
  .refine((value) => value === null || (value.length <= 1000 && !value.includes("\0") && path.isAbsolute(value)), "the Inbox folder must be an absolute path");

/** `PUT /api/review-notify` -- a field left out keeps its value; `enabled: null` / `inboxPath: null` return to the default. */
export const reviewNotifySettingsInputSchema = z
  .object({
    enabled: z.union([z.boolean(), z.null()]).optional(),
    inboxPath: inboxPathSchema.optional(),
  })
  .strict();

export function parseStoredSettings(json: string | null): ReviewNotifySettings {
  if (!json) return { ...DEFAULT_REVIEW_NOTIFY_SETTINGS };
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : null,
      inboxPath: typeof value.inboxPath === "string" && path.isAbsolute(value.inboxPath) ? value.inboxPath : null,
    };
  } catch {
    return { ...DEFAULT_REVIEW_NOTIFY_SETTINGS };
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

export function parseStoredState(json: string | null): ReviewNotifyState {
  if (!json) return { ...INITIAL_REVIEW_NOTIFY_STATE };
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return {
      activeSince: text(value.activeSince),
      singlesFloor: text(value.singlesFloor),
      backfillDone: value.backfillDone === true,
      lastTickAt: text(value.lastTickAt),
      lastError: text(value.lastError),
      lastFile: text(value.lastFile),
      lastWrittenAt: text(value.lastWrittenAt),
      writtenCount: typeof value.writtenCount === "number" && Number.isSafeInteger(value.writtenCount) && value.writtenCount >= 0 ? value.writtenCount : 0,
    };
  } catch {
    return { ...INITIAL_REVIEW_NOTIFY_STATE };
  }
}
