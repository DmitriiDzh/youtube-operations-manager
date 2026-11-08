// BL-248 (ADR 0066, docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md): the shared review-notify module. No feature module and no database
// here (AGENTS.md §M, AC-RN-14): the production writer -- its sources, settings and ledger -- is composed in
// `src/composition/review-notify.ts`; the feature modules reach it only through `nudgeReviewNotify`, injected in their own index.ts.

export * from "./contracts";
export * from "./render";
export { createReviewNotify, mergePlanFeeds, planPassReady, type ReviewNotify } from "./services";
export { reviewNotifySettingsInputSchema, parseStoredSettings, parseStoredState } from "./schemas";
export { createInboxWriter, sweepInboxTemp, nodeInboxFsOps, isDirectory, workspaceRootOf, producerFolderOf, defaultInboxOf, type InboxFsOps } from "./adapters/fs";

const NUDGE_KEY = Symbol.for("ytom.reviewNotify.nudge");
type GlobalWithNudge = typeof globalThis & { [NUDGE_KEY]?: () => void };

/**
 * The server's loop registers what a nudge does (run the writer soon). Kept on globalThis: the routes that record the owner's
 * decisions and the server's loop are separate bundles of one process.
 */
export function registerReviewNotifyNudge(handler: (() => void) | null): void {
  const holder = globalThis as GlobalWithNudge;
  if (handler) holder[NUDGE_KEY] = handler;
  else delete holder[NUDGE_KEY];
}

/**
 * "The owner just decided something here": the writer runs in a moment instead of at its next tick. Never throws and never waits:
 * the owner's decision is already recorded and must not depend on this (REVIEW_NOTIFY_PLAN.md §9). Without a registered loop (a
 * `next dev` server, a test, the CLI) it does nothing.
 */
export function nudgeReviewNotify(): void {
  try {
    (globalThis as GlobalWithNudge)[NUDGE_KEY]?.();
  } catch {
    // The decision never fails over a nudge.
  }
}
