import type { AutoCollectResult } from "./contracts";

/**
 * BL-142 (owner, Telegram 2026-10-06, msgs 1867/1868/1874): the dashboard's automatic Analytics collection for EVERY
 * connected channel, not only the active one -- the same shape as BL-141's Reach sync (reach-reports
 * `syncAllReachReports`).
 *
 * - The session's active channel uses the session's credentials, exactly as the single-channel automatic call did.
 *   Every other channel uses its OWN Google user's credentials (`channels.connected_user_id`) and goes through the same
 *   per-channel functions, so their active-channel check still applies: a user who has since switched to another
 *   channel fails closed for this one instead of collecting it with a token that is no longer its own.
 * - The per-channel functions are injected, and `index.ts` passes the quota-guarded versions (BL-117 reserve, quota
 *   ledger attribution), so a background channel is held back exactly like the active one. Channels therefore run one
 *   after another: each sees the quota the previous one left.
 * - Per channel the order is unchanged: rolling collection, then the weekly report (a Monday load's weekly snapshot must
 *   see that load's own collection). A channel whose collection failed gets no weekly report this time.
 * - History catch-up (BL-118) is only planned here; the caller runs the returned list after its response.
 * - One channel failing never stops the others (AGENTS.md §M). A Google-side failure is throttled by
 *   `collectMetrics`'s own mark-then-run daily gate, as it always was.
 */
export type AutoCollectAllDeps = {
  listChannelConnections(): Promise<Array<{ channelId: string; connectedUserId: string | null }>>;
  getActiveChannelId(userId: string): Promise<string | null>;
  runAutoCollectionIfStale(input: unknown): Promise<AutoCollectResult>;
  runWeeklyReportIfDue(input: unknown): Promise<unknown>;
  getHistoryCatchUpPlan(input: unknown): Promise<{ videoRanges: readonly unknown[]; channelRange: unknown | null }>;
};

export type AutoCollectChannelOutcome =
  | { channelId: string; collection: "collected" | "current" }
  | { channelId: string; collection: "skipped_no_user" }
  | { channelId: string; collection: "failed"; error: string; code?: string };

export type AutoCollectAllResult = {
  channels: AutoCollectChannelOutcome[];
  /** Channels whose history still has gaps, with the credentials to close them (run after the response). */
  catchUps: Array<{ channelId: string; credentialRef: { userId: string } }>;
};

function errorCodeOf(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export async function runAutoCollectionForAllChannels(
  deps: AutoCollectAllDeps,
  input: { sessionUserId: string }
): Promise<AutoCollectAllResult> {
  const [connections, activeChannelId] = await Promise.all([
    deps.listChannelConnections(),
    deps.getActiveChannelId(input.sessionUserId),
  ]);
  const channels: AutoCollectChannelOutcome[] = [];
  const catchUps: AutoCollectAllResult["catchUps"] = [];

  for (const { channelId, connectedUserId } of connections) {
    const userId = channelId === activeChannelId ? input.sessionUserId : connectedUserId;
    if (!userId) {
      channels.push({ channelId, collection: "skipped_no_user" });
      continue;
    }
    const credentialRef = { userId };

    try {
      const result = await deps.runAutoCollectionIfStale({ credentialRef, channelId });
      channels.push({ channelId, collection: result.ranCollection ? "collected" : "current" });
    } catch (error) {
      const code = errorCodeOf(error);
      channels.push({ channelId, collection: "failed", error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
      continue;
    }

    try {
      await deps.runWeeklyReportIfDue({ credentialRef, channelId });
    } catch {
      // Local and best-effort: the due-week check retries on the next dashboard load.
    }

    try {
      const plan = await deps.getHistoryCatchUpPlan({ credentialRef, channelId });
      if (plan.videoRanges.length > 0 || plan.channelRange) catchUps.push({ channelId, credentialRef });
    } catch {
      // Planning is best-effort: it never turns a successful collection into an error.
    }
  }

  return { channels, catchUps };
}
