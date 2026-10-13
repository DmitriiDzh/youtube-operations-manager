import { sleep as sharedSleep } from "@/lib/shared-async";
import type { VideoDetailsPatch, VideoDetailsSnapshot } from "./contracts";

/** YouTube applies some fields (observed live: `defaultAudioLanguage`, 2026-10-03) with a delay, so
 * the first read right after `videos.update` can still return the old value. Owner-chosen: 3 retries,
 * 10 s apart (each retry is one `videos.list` = 1 quota unit). */
export const READ_BACK_RETRIES = 3;
export const READ_BACK_RETRY_DELAY_MS = 10_000;

/** Fields that are instants: YouTube echoes `2026-10-16T12:00:00Z` for a sent `2026-10-16T12:00:00.000Z` (BL-182 review B1). */
const INSTANT_FIELDS = new Set<string>(["publishAt", "recordingDate"]);

/**
 * Fields YouTube accepts but does not return on read (G1, 2026-10-13: `status.containsSyntheticMedia` reads back null). A null read-back
 * of such a field cannot confirm or refute the write: it is reported as unverifiable, not as a mismatch.
 */
export const WRITE_ONLY_FIELDS = new Set<string>(["containsSyntheticMedia"]);

/**
 * BL-182 review: `videos.update` replaces the whole status part, so a status write must carry every write-only status field the read
 * could not supply -- otherwise it is silently reset. Returns the missing ones (empty = safe to write).
 */
export function missingWriteOnlyStatusFields(touchesStatus: boolean, readStatus: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  if (!touchesStatus) return [];
  return [...WRITE_ONLY_FIELDS].filter((field) => (readStatus[field] === null || readStatus[field] === undefined) && !(field in patch));
}

export function isUnverifiable(field: string, readBack: unknown): boolean {
  return WRITE_ONLY_FIELDS.has(field) && (readBack === null || readBack === undefined);
}

/** Whether a read-back value is what was written: instants compare as instants, lists by content, the rest exactly. */
export function sameFieldValue(field: string, readBack: unknown, written: unknown): boolean {
  if (isUnverifiable(field, readBack)) return true;
  if (INSTANT_FIELDS.has(field) && typeof readBack === "string" && typeof written === "string") {
    const a = Date.parse(readBack);
    const b = Date.parse(written);
    return !Number.isNaN(a) && a === b;
  }
  return Array.isArray(readBack) || Array.isArray(written) ? JSON.stringify(readBack) === JSON.stringify(written) : readBack === written;
}

export function patchReadBack(snapshot: VideoDetailsSnapshot, patch: VideoDetailsPatch): boolean {
  return (Object.keys(patch) as Array<keyof VideoDetailsPatch>).every((field) =>
    sameFieldValue(field, snapshot[field as keyof VideoDetailsSnapshot], patch[field])
  );
}

/**
 * Reads the video back and, only while the patched fields do not yet match, re-reads up to
 * `retries` more times after `delayMs`. Returns the last snapshot either way -- it never decides
 * success: the caller's verification still fails closed on a genuine mismatch after the last retry.
 */
export async function readBackUntilApplied(args: {
  read: () => Promise<VideoDetailsSnapshot>;
  patch: VideoDetailsPatch;
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VideoDetailsSnapshot> {
  const retries = args.retries ?? READ_BACK_RETRIES;
  const delayMs = args.delayMs ?? READ_BACK_RETRY_DELAY_MS;
  const sleep = args.sleep ?? sharedSleep;
  let snapshot = await args.read();
  for (let attempt = 0; attempt < retries && !patchReadBack(snapshot, args.patch); attempt++) {
    await sleep(delayMs);
    snapshot = await args.read();
  }
  return snapshot;
}
