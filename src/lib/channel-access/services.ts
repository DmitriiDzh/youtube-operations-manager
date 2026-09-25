import { DomainError } from "@/lib/video-metadata/contracts";
import type { ChannelAccessDependencies } from "./contracts";

/**
 * Resolves and enforces "the channel currently active for this session" for READ surfaces
 * (Web API, MCP, CLI) -- the project owner's explicit decision (2026-09-20): every piece of
 * information a session can see must be scoped exclusively to whichever channel is active for
 * it, closing docs/TECHNICAL_DEBT.md RISK-02.
 *
 * Deliberately reuses the same `selectedChannelId` storage as `write-context/services.ts`
 * (single source of truth per AGENTS.md §D's "one guardrail per domain"), but NOT
 * `assertWriteChannel`'s live-YouTube-API cross-check -- that check exists because a write must
 * never fire against the wrong channel even if local storage is stale, which justifies its cost.
 * Read listing endpoints are documented as making zero live YouTube API calls
 * (docs/ARCHITECTURE.md §4.3); a live call on every list/get would both violate that invariant
 * and add YouTube API quota cost with no corresponding write-safety benefit. `selectedChannelId`
 * is kept fresh for this purpose by being written back from every place the app already learns
 * the OAuth-live channel for free (`GET /api/youtube/channel-info`, and `syncChannel`'s
 * implicit/"mine" resolution) -- see those call sites.
 */
export function createChannelAccessService(deps: ChannelAccessDependencies) {
  async function getActiveChannelId(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    return deps.getSelectedChannelId(userId);
  }

  /**
   * Fail-closed by construction: a `userId` with no stored selection (never yet resolved a live
   * channel) has `activeChannelId === null`, which never equals any real `channelId` -- so a
   * brand-new session sees/can access nothing until its active channel is known, rather than
   * defaulting to "everything."
   */
  async function assertActiveChannel(args: {
    userId: string | null | undefined;
    channelId: string;
  }): Promise<string> {
    const activeChannelId = await getActiveChannelId(args.userId);
    if (!activeChannelId || activeChannelId !== args.channelId) {
      throw new DomainError({
        code: "CHANNEL_NOT_ACTIVE",
        message: "The requested channel is not this session's currently active channel.",
        details: { channelId: args.channelId, activeChannelId },
      });
    }
    return activeChannelId;
  }

  /** For list endpoints: narrows to the active channel instead of throwing (an empty/absent
   * active channel simply yields an empty list -- there is nothing to be unauthorized *about*
   * yet). */
  function filterToActiveChannel<T extends { channelId: string }>(
    items: readonly T[],
    activeChannelId: string | null
  ): T[] {
    if (!activeChannelId) return [];
    return items.filter((item) => item.channelId === activeChannelId);
  }

  /** Called from the specific, narrow set of places that resolve a channel directly against the
   * live, currently-authenticated OAuth session (never from an explicit/arbitrary channelId
   * a caller merely passed in) -- see callers for why each one qualifies. */
  async function activateChannel(args: { userId: string; channelId: string }): Promise<void> {
    await deps.setSelectedChannelId(args.userId, args.channelId);
  }

  return { getActiveChannelId, assertActiveChannel, filterToActiveChannel, activateChannel };
}

export type ChannelAccessService = ReturnType<typeof createChannelAccessService>;
