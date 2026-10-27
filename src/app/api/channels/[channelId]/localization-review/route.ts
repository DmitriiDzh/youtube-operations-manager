import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { listLocalizationReviewQueue } from "@/lib/localization-review";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
  listQueue: typeof listLocalizationReviewQueue;
};

/** BL-227 (LANGUAGES_REVIEW_PLAN.md §6): the translation review queue of the active channel -- one entry per video waiting for the owner. Read-only. */
export function createReviewQueueHandler(deps: Deps = { getSession: () => getServerSession(authOptions), channelAccess: createChannelAccessCore(), listQueue: listLocalizationReviewQueue }) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      return NextResponse.json({ videos: await deps.listQueue(channelId) });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createReviewQueueHandler();
