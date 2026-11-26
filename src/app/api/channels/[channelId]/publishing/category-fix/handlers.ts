import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageCategoryCore, type PackageMetadataActor } from "@/lib/publishing";
import { isDomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type CategoryFixRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  preview: (channelId: string, actor: PackageMetadataActor) => Promise<unknown>;
  apply: (channelId: string, input: { expectedCategoryId?: string; videoIds?: string[] }, actor: PackageMetadataActor) => Promise<unknown>;
};

function errorResponse(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "operation_lock_held" || code === "device_in_recovery_mode") {
    return NextResponse.json({ error: code, message: error instanceof Error ? error.message : String(code) }, { status: 423 });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-279 (owner TG 4963/4964; AGENTS.md §F → docs/WRITE_AUTHORIZATIONS.md «Package metadata after upload», amended 2026-11-26): the
 * owner's category fix -- `{ dryRun: true }` lists the channel's package-uploaded videos with their category now and what would be
 * written (no write); `{ expectedCategoryId, videoIds? }` sets each listed video's category to the channel's saved setting through
 * video-details (identity check, backup, Live writes, read-back, audit). No category is taken from the request: `expectedCategoryId`
 * only binds the apply to what the preview showed. The owner's session and the active channel only.
 */
export function createCategoryFixHandlers(
  deps: CategoryFixRouteDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    preview: (channelId, actor) => createPackageCategoryCore().preview(channelId, actor),
    apply: (channelId, input, actor) => createPackageCategoryCore().apply(channelId, input, actor),
  }
) {
  return {
    async POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
      const session = await deps.getSession();
      const userId = session?.user?.id;
      if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId, channelId });
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return NextResponse.json({ error: "validation_failed", message: "a JSON body is required" }, { status: 400 });
        const actor: PackageMetadataActor = { kind: "owner", userId };
        if (body.dryRun === true) return NextResponse.json(await deps.preview(channelId, actor));
        if (body.videoIds !== undefined && (!Array.isArray(body.videoIds) || body.videoIds.some((id) => typeof id !== "string"))) {
          return NextResponse.json({ error: "validation_failed", message: "videoIds must be a list of video ids" }, { status: 400 });
        }
        return NextResponse.json(
          await deps.apply(
            channelId,
            {
              ...(typeof body.expectedCategoryId === "string" ? { expectedCategoryId: body.expectedCategoryId } : {}),
              ...(Array.isArray(body.videoIds) ? { videoIds: body.videoIds as string[] } : {}),
            },
            actor
          )
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
