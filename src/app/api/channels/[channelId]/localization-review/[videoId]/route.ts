import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { getLocalizationReview } from "@/lib/localization-review";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
  getReview: typeof getLocalizationReview;
};

/**
 * BL-227 (LANGUAGES_REVIEW_PLAN.md §6): one video's translation review on the active channel -- its languages with the changes of
 * every set, checks, the agent's report and note. Read-only; approve/reject use the change-set routes. `review: null` when nothing of
 * the video waits for the owner (the video id is only looked up among this channel's synced videos).
 */
export function createVideoReviewHandler(deps: Deps = { getSession: () => getServerSession(authOptions), channelAccess: createChannelAccessCore(), getReview: getLocalizationReview }) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string; videoId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, videoId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      return NextResponse.json({ review: await deps.getReview(channelId, videoId) });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createVideoReviewHandler();
