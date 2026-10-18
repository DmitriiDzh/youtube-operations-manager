import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { createSendApprovedCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const bodySchema = z
  .object({
    changeSetIds: z.array(z.string().min(1)).min(1).max(50),
    resolutions: z.array(z.object({ videoId: z.string().min(1), language: z.string().min(1), changeSetId: z.string().min(1) }).strict()).max(5000).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

type SendTogetherRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createSendApprovedCore>, "createBatchForChangeSets">;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
};

/**
 * BL-198 (docs/roadmap/plans/SEND_TOGETHER_PLAN.md): one batch from several change sets -- one row per video carrying all their
 * sendable changes. Like the one-set send (ADR 0020) it only SELECTS and CREATES; the browser then runs the existing execute route.
 * Collisions between sets need `resolutions` (`send_merge_conflicts` lists them); a live send rejects the variants not kept.
 * `dryRun: true` (the Batches tab) creates a dry-run batch and rejects nothing.
 */
export function createSendTogetherHandler(
  deps: SendTogetherRouteDeps = { getSession: () => getServerSession(authOptions), core: createSendApprovedCore(), channelAccess: createChannelAccessCore() }
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
        return NextResponse.json({ error: "validation_failed", message: "changeSetIds (1-50) is required; resolutions and dryRun are optional" }, { status: 400 });
      }

      const result = await deps.core.createBatchForChangeSets({ channelId, ...parsed.data });
      return NextResponse.json(
        { batchId: result.batch.id, changeCount: result.changeCount, videoCount: result.videoCount, rejectedChangeIds: result.rejectedChangeIds, batch: result.batch },
        { status: 201 }
      );
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

export const POST = createSendTogetherHandler();
