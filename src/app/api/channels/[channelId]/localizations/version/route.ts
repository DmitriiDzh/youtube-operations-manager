import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/localization/contracts";
import { createLocalizationCore } from "@/lib/localization";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

const core = createLocalizationCore();
const channelAccess = createChannelAccessCore();

/**
 * BL-178 part C (LOCALIZATION_BASELINE_PLAN §3.3 C1): a fingerprint of what the Languages page and a Change Set read for the
 * channel. An open page polls it every 15 s while visible and reloads when it moves -- after a Batch run from any page or by an
 * agent, a sync, or a language setting arriving from the other computer. A local read: never a YouTube call.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    return NextResponse.json(await core.getLocalizationVersion({ channelId }));
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
