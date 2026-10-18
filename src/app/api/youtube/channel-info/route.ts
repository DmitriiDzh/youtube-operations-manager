import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube } from "@/lib/youtube-read-gateway";
import { createChannelAccessCore, liveChannelEpoch, recallLiveChannel, rememberLiveChannel, type LiveChannelInfo } from "@/lib/channel-access";
import { runWithQuotaContext } from "@/lib/youtube-quota";

const channelAccess = createChannelAccessCore();

type ChannelInfoDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  /** `channels.list mine` with this identity's own grant; null when the grant names no channel. */
  readLiveChannel: (userId: string) => Promise<LiveChannelInfo | null>;
  activateChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  memo: { recall(userId: string): LiveChannelInfo | null; epoch(userId: string): number; remember(userId: string, channel: LiveChannelInfo, epoch: number): void };
};

async function readLiveChannel(userId: string): Promise<LiveChannelInfo | null> {
  // BL-197: listed by name in the Settings quota history, so the header's share of the quota is visible.
  const res = await runWithQuotaContext({ kind: "channel_header", id: null, label: "Header: active channel" }, async () => {
    const youtube = await getAuthenticatedYoutube(userId);
    return youtube.channels.list({
      part: ["snippet", "statistics"],
      mine: true,
    });
  });
  const channel = res.data.items?.[0];
  if (!channel?.id) return null;
  return {
    id: channel.id,
    title: channel.snippet?.title ?? null,
    thumbnail: channel.snippet?.thumbnails?.default?.url ?? null,
    videoCount: channel.statistics?.videoCount ?? null,
    // Studio-Parity S4 (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4) -- Home's "Channel
    // analytics" card's "Current subscribers" number. Already present on this same response's
    // `statistics` part (requested above); additive field, no new API call.
    subscriberCount: channel.statistics?.subscriberCount ?? null,
  };
}

/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2984): the live read runs once per signed-in identity and is then answered from the memo
 * (`live-channel-memo.ts`, 6 h) -- a reload, a new tab or a return to the window no longer spends quota. Every answer, remembered or
 * live, still records the channel as this session's active one (ADR 0004), which the dashboard's collections wait for.
 */
export function createChannelInfoHandler(
  deps: ChannelInfoDeps = {
    getSession: () => getServerSession(authOptions),
    readLiveChannel,
    activateChannel: (args) => channelAccess.activateChannel(args),
    memo: { recall: (userId) => recallLiveChannel(userId), epoch: liveChannelEpoch, remember: (userId, channel, epoch) => rememberLiveChannel(userId, channel, epoch) },
  }
) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let channel = deps.memo.recall(userId);
    if (!channel) {
      // A sign-in or disconnect while this read runs forgets the identity; the older answer is then not remembered.
      const epoch = deps.memo.epoch(userId);
      try {
        channel = await deps.readLiveChannel(userId);
      } catch (error) {
        // Reachable in practice since `docs/decisions/0010-persistent-channel-connections.md` made
        // reactivating an older stored connection a first-class action -- its refresh token can have
        // genuinely gone stale with Google (e.g. testing-mode 7-day expiry) since it was last used.
        // Without this, the underlying `invalid_grant` propagated as an unhandled exception, which
        // Next.js turned into a non-JSON error response the client's `res.json()` then crashed on.
        //
        // The real error is logged server-side only, never forwarded to the client verbatim
        // (AGENTS.md §F) -- whatever exception type actually reaches this catch in the future (a
        // library internal, a misconfigured client, not just this scenario's `invalid_grant`), the
        // client only ever sees this one fixed, generic message.
        try {
          console.error(JSON.stringify({
            level: "error",
            event: "youtube.channel_info.unavailable",
            context: { userId, error: error instanceof Error ? error.message : String(error) },
          }));
        } catch {
          // A structured log is a nice-to-have, not a requirement -- if it somehow can't be
          // serialized, fall back to a plain log rather than let that itself reproduce the exact
          // "unhandled throw escapes this catch" failure this whole block exists to prevent.
          console.error("youtube.channel_info.unavailable", error);
        }
        return NextResponse.json(
          {
            error: "channel_info_unavailable",
            message: "Could not load the active channel. It may need to be reconnected.",
          },
          { status: 502 }
        );
      }
      if (!channel) {
        return NextResponse.json({ channel: null });
      }
      deps.memo.remember(userId, channel, epoch);
    }

    // This is the one place the Web UI learns, for free, which channel the live OAuth session
    // actually grants access to right now -- persisting it here is what keeps `selectedChannelId`
    // (docs/decisions/0004-active-channel-read-scoping.md) accurate for the read-scoping filter,
    // without requiring a separate "select active channel" UI step or a live API call on every
    // read-list request. A remembered answer is that same live answer, younger than the memo's TTL.
    await deps.activateChannel({ userId, channelId: channel.id });

    return NextResponse.json({ channel });
  };
}

export const GET = createChannelInfoHandler();
