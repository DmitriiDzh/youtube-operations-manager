import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/video-details/contracts";
import { createVideoDetailsCore } from "@/lib/video-details";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createVideoDetailsCore();
const channelAccess = createChannelAccessCore();

/**
 * Studio-parity "Details" edit -- plain read of the current snapshot, no patch involved. What a
 * Details panel loads on open (`src/lib/video-details/services.ts`'s `getSnapshot`). Never
 * gated by `src/proxy.ts` (GET is never in `MUTATING_METHODS`), and records no audit event --
 * a view changes nothing about the video.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; videoId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, videoId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    const result = await core.getSnapshot({
      credentialRef: { userId: session.user.id },
      expectedChannelId: channelId,
      videoId,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }

    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
