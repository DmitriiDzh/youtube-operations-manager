import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createVideoThumbnailsCore } from "@/lib/video-thumbnails";

const channelAccess = createChannelAccessCore();

type Params = { params: Promise<{ channelId: string; videoId: string }> };

function errorResponse(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/** BL-255 (ADR 0069): the images the owner can choose from for this video's new thumbnail. Read-only. */
export async function GET(request: Request, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { channelId, videoId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    // `vn` (optional, e.g. V4): the video's number as the screen knows it -- only orders the folders, never widens what is read.
    const vn = new URL(request.url).searchParams.get("vn");
    return NextResponse.json(await createVideoThumbnailsCore().listCandidates(channelId, videoId, vn && /^V\d{1,6}$/.test(vn) ? vn : null));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * BL-255 (ADR 0069): replace the video's custom thumbnail (`{ path, dryRun? }`) -- with `dryRun` every read and check and no
 * write; otherwise backup, identity check, Live writes, `thumbnails.set`, read-back and audit (`src/lib/video-thumbnails/`).
 */
export async function POST(request: Request, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { channelId, videoId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    const result = await createVideoThumbnailsCore().replace({ channelId, videoId, path: body.path, dryRun: body.dryRun === true }, { kind: "owner", userId: session.user.id });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
