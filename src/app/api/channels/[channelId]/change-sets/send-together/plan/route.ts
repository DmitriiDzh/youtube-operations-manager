import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { createSendApprovedCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const bodySchema = z.object({ changeSetIds: z.array(z.string().min(1)).min(1).max(50) }).strict();

type PlanRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createSendApprovedCore>, "planSendTogether">;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
};

/**
 * BL-198: read only -- what sending these change sets together would create (videos, changes, languages, estimated quota), the
 * collisions the owner must decide first, and an unfinished live batch already holding some of these changes. A POST only because
 * the selection is a body; nothing is written.
 */
export function createSendTogetherPlanHandler(
  deps: PlanRouteDeps = { getSession: () => getServerSession(authOptions), core: createSendApprovedCore(), channelAccess: createChannelAccessCore() }
) {
  return async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { channelId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json({ error: "validation_failed", message: "changeSetIds (1-50) is required" }, { status: 400 });
      }
      return NextResponse.json(await deps.core.planSendTogether({ channelId, changeSetIds: parsed.data.changeSetIds }));
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
  };
}

export const POST = createSendTogetherPlanHandler();
