import { getAgentSession } from "@/lib/agent-session";
import { DomainError } from "@/lib/video-metadata/contracts";

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
