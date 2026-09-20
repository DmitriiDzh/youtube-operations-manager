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
 * Studio-parity "Details" edit, apply step (2026-09-20) -- the first real, non-dry-run YouTube
 * write reachable from this app's Web UI. Owner-authorized (Telegram, after being told this
 * path has none of Batches' backup/diff/approval/audit protections by default and choosing to
 * have this module build its own, per AGENTS.md §G). NOT exempted from `src/proxy.ts`'s
 * operation-lock/device-availability gate -- a real mutation stays gated like any other.
 * `src/lib/video-details/services.ts`'s `applyFieldsUpdate` itself: checks write-channel
 * identity, captures an immutable pre-write backup, applies only the patched fields (merged
 * onto a fresh read, never touching `localizations` or an untouched field), re-reads to verify,
 * and records every step to `video_edit_audit_events`.
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

    const result = await core.applyFieldsUpdate({
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
