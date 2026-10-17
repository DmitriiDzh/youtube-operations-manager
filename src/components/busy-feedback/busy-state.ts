// BL-195 (docs/roadmap/plans/UI_FEEDBACK_CLARITY_PLAN.md §2): when a short action's blocking window shows and hides, and how
// long the other feedback stays. Pure, so the rules are tested without a browser.

/** An action that ends sooner shows no window at all (no flicker). */
export const BUSY_SHOW_DELAY_MS = 300;
/** Once shown, the window stays at least this long, so it never flashes. */
export const BUSY_MIN_VISIBLE_MS = 500;
/** A `hold` (a wait that is not a request) closes by itself after this long. */
export const BUSY_HOLD_MAX_MS = 20_000;
/** How long a button shows "✓" after its action succeeded. */
export const ACTION_DONE_FLASH_MS = 2_000;
/** How long a success message stays; an error stays until it is closed. */
export const NOTICE_OK_MS = 4_000;

/**
 * The window of an action that started at `startedAt` and ended at `endedAt` (null = still running): `null` when it never shows,
 * else when it shows and when it hides (`hideAt` null while the action still runs).
 */
export function busyWindow(startedAt: number, endedAt: number | null): { showAt: number; hideAt: number | null } | null {
  const showAt = startedAt + BUSY_SHOW_DELAY_MS;
  if (endedAt !== null && endedAt < showAt) return null;
  return { showAt, hideAt: endedAt === null ? null : Math.max(endedAt, showAt + BUSY_MIN_VISIBLE_MS) };
}

/** Whether that window is shown at `now`. */
export function busyVisibleAt(startedAt: number, endedAt: number | null, now: number): boolean {
  const window = busyWindow(startedAt, endedAt);
  if (!window || now < window.showAt) return false;
  return window.hideAt === null || now < window.hideAt;
}
