/**
 * Shared rules for work that the dashboard runs for EVERY connected channel (BL-141 Reach reports, BL-142 Analytics),
 * one owner instead of a copy in each feature module (AGENTS.md §M). Pure functions only; `index.ts` adds the one
 * database read.
 */

export type ChannelConnection = { channelId: string; connectedUserId: string | null };

/**
 * Whose credentials a channel is processed with: the session's own for its active channel (exactly as the
 * single-channel automatic calls always did), the channel's own connected Google user for every other channel, or
 * `null` when a background channel has no connected user. The feature's own `assertActiveChannel` still runs on that
 * user, so a user who has since selected another channel fails closed for this one.
 */
export function credentialUserIdFor(
  connection: ChannelConnection,
  context: { activeChannelId: string | null; sessionUserId: string }
): string | null {
  return connection.channelId === context.activeChannelId ? context.sessionUserId : connection.connectedUserId;
}

/** A domain error's code (e.g. CHANNEL_NOT_ACTIVE), when the error carries one. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** How long a background channel whose automatic run failed is left alone before the next try. */
export const BACKGROUND_FAILURE_BACKOFF_HOURS = 6;

/**
 * In-process backoff for background channels whose automatic run failed, for a feature that has no persisted attempt
 * record of its own (Reach keeps one in `reporting_sync_attempts`). A failure is remembered for
 * BACKGROUND_FAILURE_BACKOFF_HOURS; a success clears it. Not persisted: a server restart allows one early retry, which
 * is acceptable for a bound whose purpose is "not on every dashboard load".
 */
export function createBackgroundFailureBackoff(clock: { now(): Date } = { now: () => new Date() }) {
  const failedAt = new Map<string, { at: Date; reason: string }>();
  return {
    /** The failure still holding this channel back, or null when it may run. */
    blocking(channelId: string): { at: Date; reason: string } | null {
      const entry = failedAt.get(channelId);
      if (!entry) return null;
      if (clock.now().getTime() - entry.at.getTime() >= BACKGROUND_FAILURE_BACKOFF_HOURS * 3_600_000) {
        failedAt.delete(channelId);
        return null;
      }
      return entry;
    },
    recordFailure(channelId: string, reason: string) {
      failedAt.set(channelId, { at: clock.now(), reason });
    },
    recordSuccess(channelId: string) {
      failedAt.delete(channelId);
    },
  };
}

export type BackgroundFailureBackoff = ReturnType<typeof createBackgroundFailureBackoff>;
