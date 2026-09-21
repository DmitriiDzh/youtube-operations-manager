import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAuthenticatedYoutube, listSupportedLanguages, type SupportedLanguage } from "@/lib/youtube";

// Global to the authenticated account, not any one channel -- deliberately not scoped by
// channelId (AGENTS.md §F would require verifying channel ownership for a channelId param this
// route has no actual use for). Module-level cache: this list is YouTube's own fixed set of
// `hl` values, not per-user/per-channel data, so one process-lifetime fetch is enough -- no TTL,
// no invalidation.
let cachedLanguages: SupportedLanguage[] | null = null;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!cachedLanguages) {
    const youtube = await getAuthenticatedYoutube(session.user.id);
    cachedLanguages = await listSupportedLanguages(youtube);
  }

  return NextResponse.json({ languages: cachedLanguages });
}
