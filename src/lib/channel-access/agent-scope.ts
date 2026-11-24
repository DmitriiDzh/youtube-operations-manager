import { getAgentSession } from "@/lib/agent-session";
import { DomainError } from "@/lib/shared-domain";

/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.3) -- confinement for the few
 * operations that do NOT go through `assertActiveChannel`: live YouTube reads that take an arbitrary
 * channelId/videoId (`list`, `transcript`, `preview`) and `channel_sync`'s explicit-channel path.
 * Outside an agent session both functions are no-ops, so operator behavior is unchanged.
 */

/** In an agent session, `channelId` (when given) must be the bound channel. */
export function assertAgentScopeChannel(channelId: string | null | undefined): void {
  const session = getAgentSession();
  if (!session || channelId === undefined || channelId === null) return;
  if (channelId !== session.channelId) {
    throw new DomainError({
      code: "CHANNEL_NOT_ACTIVE",
      message: "The requested channel is not this session's currently active channel.",
      details: { channelId },
    });
  }
}

/**
 * In an agent session (a channel worker, or the Producer calling for one channel), a YouTube write's `expectedChannelId` (when given)
 * must be the bound channel -- refused with the write-channel guardrail's own code, before any credential or YouTube call. The
 * guardrail itself (`write-context.assertWriteChannel`) still runs after it; this only fails earlier and without a network call.
 */
export function assertAgentScopeWriteChannel(expectedChannelId: string | null | undefined): void {
  const session = getAgentSession();
  if (!session || expectedChannelId === undefined || expectedChannelId === null) return;
  if (expectedChannelId !== session.channelId) {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId is not this session's channel.",
      details: { expectedChannelId, activeWriteChannelId: session.channelId },
    });
  }
}

/**
 * In an agent session, `videoId` must be a video of the bound channel, as known from the local
 * sync mirror. Unknown or foreign videos get the same `not_found` (fail-closed: a video never
 * synced for the bound channel is not reachable -- sync the channel first).
 */
export async function assertAgentScopeVideo(
  videoId: string,
  lookup: (channelId: string, videoId: string) => Promise<unknown | null>
): Promise<void> {
  const session = getAgentSession();
  if (!session) return;
  if (!(await lookup(session.channelId, videoId))) {
    throw new DomainError({ code: "not_found", message: "video not found", details: { videoId } });
  }
}

/** Reads a string field from an as-yet-unvalidated input object without trusting its shape. */
export function readStringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * ADR 0048 (BL-215, owner msg 3384): a channel-bound agent never makes a VIDEO public -- that stays the owner's (amended by owner msg
 * 4782, 2026-11-23: a playlist may be made public, so the playlist core no longer calls this; `worker-privacy` calls it for a video).
 * Outside an agent session (the owner's Web UI) this is a no-op. Called before any credential or YouTube call.
 */
export function assertAgentMayNotPublish(privacyStatus: string | null | undefined): void {
  if (privacyStatus !== "public" || !getAgentSession()) return;
  throw new DomainError({
    code: "AGENT_PUBLIC_NOT_ALLOWED",
    message: "A channel agent cannot make a video public -- that stays the owner's. Use private or unlisted.",
    details: { privacyStatus },
  });
}
