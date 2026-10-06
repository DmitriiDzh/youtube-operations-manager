import { credentialUserIdFor, errorCodeOf, type BackgroundFailureBackoff, type ChannelConnection } from "@/lib/channel-fanout/policy";
import type { AutoCollectResult } from "./contracts";

/**
 * BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): the dashboard's automatic Analytics collection for EVERY
 * connected channel, not only the active one -- the same shape as BL-141's Reach sync, with the shared rules from
 * `channel-fanout` (which credentials, error codes, background backoff).
 *
 * - The session's active channel uses the session's credentials and is collected first, while the dashboard waits, as
 *   it always was. Every other channel ("background") runs after the response, with its OWN Google user's credentials,
 *   through the same per-channel functions -- so their active-channel check still applies: a user who has since
 *   switched to another channel fails closed for this one instead of collecting it with a token that is no longer its
 *   own.
 * - The per-channel functions are injected; `index.ts` passes the quota-guarded versions (BL-117 reserve, quota ledger
 *   attribution), so a background channel is held back exactly like the active one. Channels run one after another, so
 *   each sees the quota the previous one left.
 * - Per channel: rolling collection, then the weekly report -- also when the collection failed (the report is built
 *   from stored data; the old dashboard chain ran it with `.finally()` for the same reason).
 * - `collectMetrics` marks a channel collected only after a successful run, so nothing else would stop a failing
 *   background channel from being retried, at full quota, on every dashboard load: a background failure holds that
 *   channel back for BACKGROUND_FAILURE_BACKOFF_HOURS (in-process). The active channel is retried at once, as before.
 * - Only one all-channels run at a time per process (a reload or a second tab would otherwise collect every channel
 *   twice while the first run is still going).
 * - History catch-up (BL-118) is only planned here; the caller runs the returned list after its response.
 * - One channel failing never stops the others (AGENTS.md §M). A reason a background channel was not collected is
 *   reported through `onBackgroundIssue` (logged); Analytics has no persisted per-attempt record to keep it in.
 */
export type AutoCollectAllDeps = {
  listChannelConnections(): Promise<ChannelConnection[]>;
  runAutoCollectionIfStale(input: unknown): Promise<AutoCollectResult>;
  runWeeklyReportIfDue(input: unknown): Promise<unknown>;
  getHistoryCatchUpPlan(input: unknown): Promise<{ videoRanges: readonly unknown[]; channelRange: unknown | null }>;
  backoff: BackgroundFailureBackoff;
  onBackgroundIssue?(channelId: string, message: string): void;
};

export type AutoCollectChannelOutcome =
  | { channelId: string; collection: "collected" | "current" }
  | { channelId: string; collection: "skipped_no_user" }
  | { channelId: string; collection: "skipped_backoff"; since: string; reason: string }
  | { channelId: string; collection: "failed"; error: string; code?: string };

export type AutoCollectAllResult = {
  channels: AutoCollectChannelOutcome[];
  /** Channels whose history still has gaps, with the credentials to close them (run after the response). */
  catchUps: Array<{ channelId: string; credentialRef: { userId: string } }>;
};

/** Process-wide (on `globalThis`, like the operation registry): every module copy Next loads must share the flag. */
const runFlag: { active: boolean } = ((globalThis as unknown as Record<symbol, { active: boolean } | undefined>)[
  Symbol.for("youtube-operations-manager.analytics-all-channels-run")
] ??= { active: false });

/** Claims the single all-channels run of this process; false while another one is still going. */
export function beginAllChannelsRun(): boolean {
  if (runFlag.active) return false;
  runFlag.active = true;
  return true;
}

export function endAllChannelsRun(): void {
  runFlag.active = false;
}

/**
 * Collects either the session's active channel (`which: "active"`) or every other connected channel (`"background"`),
 * one after another. `activeChannelId` is resolved once by the caller and used for both parts.
 */
export async function runAutoCollectionForChannels(
  deps: AutoCollectAllDeps,
  input: { sessionUserId: string; activeChannelId: string | null; which: "active" | "background" }
): Promise<AutoCollectAllResult> {
  const connections = await deps.listChannelConnections();
  const background = input.which === "background";
  const targets: ChannelConnection[] = background
    ? connections.filter((c) => c.channelId !== input.activeChannelId)
    : input.activeChannelId
      ? [{ channelId: input.activeChannelId, connectedUserId: connections.find((c) => c.channelId === input.activeChannelId)?.connectedUserId ?? null }]
      : [];

  const channels: AutoCollectChannelOutcome[] = [];
  const catchUps: AutoCollectAllResult["catchUps"] = [];

  for (const connection of targets) {
    const { channelId } = connection;
    const userId = credentialUserIdFor(connection, { activeChannelId: input.activeChannelId, sessionUserId: input.sessionUserId });
    if (!userId) {
      deps.onBackgroundIssue?.(channelId, "not collected: no Google account is connected for this channel");
      channels.push({ channelId, collection: "skipped_no_user" });
      continue;
    }
    const held = background ? deps.backoff.blocking(channelId) : null;
    if (held) {
      channels.push({ channelId, collection: "skipped_backoff", since: held.at.toISOString(), reason: held.reason });
      continue;
    }
    const credentialRef = { userId };
    let collectionFailed = false;

    try {
      const result = await deps.runAutoCollectionIfStale({ credentialRef, channelId });
      channels.push({ channelId, collection: result.ranCollection ? "collected" : "current" });
      if (background) deps.backoff.recordSuccess(channelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCodeOf(error);
      collectionFailed = true;
      channels.push({ channelId, collection: "failed", error: message, ...(code ? { code } : {}) });
      if (background) {
        deps.backoff.recordFailure(channelId, code ?? message);
        deps.onBackgroundIssue?.(channelId, `not collected: ${code ?? message}`);
      }
    }

    try {
      await deps.runWeeklyReportIfDue({ credentialRef, channelId });
    } catch {
      // Local and best-effort: the due-week check retries on the next dashboard load.
    }

    // A channel whose collection just failed would fail the catch-up the same way: plan it on a later load.
    if (collectionFailed) continue;
    try {
      const plan = await deps.getHistoryCatchUpPlan({ credentialRef, channelId });
      if (plan.videoRanges.length > 0 || plan.channelRange) catchUps.push({ channelId, credentialRef });
    } catch {
      // Planning is best-effort (and refused for a channel whose user switched away).
    }
  }

  return { channels, catchUps };
}
