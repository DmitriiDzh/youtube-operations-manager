import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube } from "@/lib/youtube-read-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";

const channelAccess = createChannelAccessCore();

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let res;
  try {
    const youtube = await getAuthenticatedYoutube(session.user.id);
    res = await youtube.channels.list({
      part: ["snippet", "statistics"],
      mine: true,
    });
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
    console.error(JSON.stringify({
      level: "error",
      event: "youtube.channel_info.unavailable",
      context: { userId: session.user.id, error: error instanceof Error ? error.message : String(error) },
    }));
    return NextResponse.json(
      {
        error: "channel_info_unavailable",
        message: "Could not load the active channel. It may need to be reconnected.",
      },
      { status: 502 }
    );
  }

  const channel = res.data.items?.[0];
  if (!channel) {
    return NextResponse.json({ channel: null });
  }

  // This is the one place the Web UI learns, for free, which channel the live OAuth session
  // actually grants access to right now -- persisting it here is what keeps `selectedChannelId`
  // (docs/decisions/0004-active-channel-read-scoping.md) accurate for the read-scoping filter,
  // without requiring a separate "select active channel" UI step or a live API call on every
  // read-list request.
  if (channel.id) {
    await channelAccess.activateChannel({ userId: session.user.id, channelId: channel.id });
  }

  return NextResponse.json({
    channel: {
      id: channel.id,
      title: channel.snippet?.title,
      thumbnail: channel.snippet?.thumbnails?.default?.url,
      videoCount: channel.statistics?.videoCount,
    },
  });
}
