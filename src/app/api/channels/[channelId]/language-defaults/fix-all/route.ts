import { getServerSession } from "next-auth";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createLanguageFixAllCore, DomainError } from "@/lib/language-fix-all";
import { isOperationAlreadyRunning } from "@/lib/operation-progress";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

const core = createLanguageFixAllCore();
const channelAccess = createChannelAccessCore();

/**
 * Starts the server-side "Fix all" run and returns at once with `{ operationId }` (202); the work
 * continues after the response (`after`) and is followed through `GET /api/operations/[id]`, which
 * keeps working across a page reload. Gated by `src/proxy.ts` like any other mutation.
 *
 * The body only names videos (and the etag each was previewed at). Which fields and values are
 * written is decided on the server from the channel baseline -- see `src/lib/language-fix-all`.
 * Every write still goes through `video-details` -> `youtube-write-gateway`; this route calls no
 * YouTube method itself.
 */
export async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    let body: { videos?: unknown; baseline?: unknown };
    try {
      body = (await request.json()) as { videos?: unknown; baseline?: unknown };
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }

    const { operationId, run } = await core.start({ channelId, userId: session.user.id, baseline: body.baseline, videos: body.videos });
    after(run);
    return NextResponse.json({ operationId }, { status: 202 });
  } catch (error) {
    if (isOperationAlreadyRunning(error)) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: { operationId: error.operationId } },
        { status: 409 }
      );
    }
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
