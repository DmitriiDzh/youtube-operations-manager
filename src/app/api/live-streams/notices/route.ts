import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createLiveStreamsNoticesCore, type LiveNotice } from "@/lib/live-streams";

// BL-176 (LIVE_STREAMS_PLAN.md §3.10 "Bell notices"): the header bell's live-stream notices for this computer's streams --
// a stream not live for longer than the alert delay, a broadcast YouTube ended, a next video missing. Local reads only.
export function createLiveNoticesGetHandler(
  deps: { getSession: () => Promise<{ user?: { id?: string | null } } | null>; list: () => Promise<LiveNotice[]> } = {
    getSession: () => getServerSession(authOptions),
    list: () => createLiveStreamsNoticesCore().list(),
  }
) {
  return async (): Promise<NextResponse> => {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return NextResponse.json({ notices: await deps.list() });
    } catch {
      // The bell never breaks over this: no notices this time, the next poll tries again.
      return NextResponse.json({ notices: [] });
    }
  };
}

export const GET = createLiveNoticesGetHandler();
