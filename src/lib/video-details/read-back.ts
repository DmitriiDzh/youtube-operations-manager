import type { VideoDetailsPatch, VideoDetailsSnapshot } from "./contracts";

/** YouTube applies some fields (observed live: `defaultAudioLanguage`, 2026-10-03) with a delay, so
 * the first read right after `videos.update` can still return the old value. Owner-chosen: 3 retries,
 * 10 s apart (each retry is one `videos.list` = 1 quota unit). */
export const READ_BACK_RETRIES = 3;
export const READ_BACK_RETRY_DELAY_MS = 10_000;

function sameValue(a: unknown, b: unknown): boolean {
  return Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}

export function patchReadBack(snapshot: VideoDetailsSnapshot, patch: VideoDetailsPatch): boolean {
  return (Object.keys(patch) as Array<keyof VideoDetailsPatch>).every((field) =>
    sameValue(snapshot[field as keyof VideoDetailsSnapshot], patch[field])
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
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let snapshot = await args.read();
  for (let attempt = 0; attempt < retries && !patchReadBack(snapshot, args.patch); attempt++) {
    await sleep(delayMs);
    snapshot = await args.read();
  }
  return snapshot;
}
