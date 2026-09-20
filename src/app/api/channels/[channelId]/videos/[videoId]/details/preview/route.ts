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
 * Studio-parity "Details" edit, preview step (2026-09-20). Read-only: never calls
 * `videos.update`, never touches backup/audit-of-a-write/write-context -- see
 * `src/lib/video-details/services.ts`'s `previewFieldsUpdate`. Exempted from the
 * operation-lock/device-availability gate in `src/proxy.ts` (like every other genuinely
 * read-only preview route) precisely because it is read-only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string; videoId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, videoId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "validation_failed", message: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    const result = await core.previewFieldsUpdate({
      ...body,
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
