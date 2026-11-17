import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageCaptionsCore, type PackageCaptionsActor } from "@/lib/publishing";
import { isDomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PackageCaptionsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  preview: (channelId: string, input: { video: string; overwrite?: boolean }, actor: PackageCaptionsActor) => Promise<unknown>;
  apply: (channelId: string, input: { video: string; overwrite?: boolean; expectedManifestSha256?: string; expectedTrackId?: string | null }, actor: PackageCaptionsActor) => Promise<unknown>;
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
 * BL-269 (ADR 0074 §8, §10; AGENTS.md §F captions writer): the owner's captions for an uploaded package -- `{ video, overwrite?,
 * dryRun: true }` previews (every read and check, the track an overwrite would replace, the units; no write); `{ video, overwrite?,
 * expectedManifestSha256, expectedTrackId }` writes the package's current captions through the captions writer (identity check,
 * backup, Live writes, read-back, audit). The owner's session and the active channel only (remote allowed, like the packaging fix).
 */
export function createPackageCaptionsHandlers(
  deps: PackageCaptionsRouteDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    preview: (channelId, input, actor) => createPackageCaptionsCore().preview(channelId, input, actor),
    apply: (channelId, input, actor) => createPackageCaptionsCore().apply(channelId, input, actor),
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
        if (!body || typeof body.video !== "string") return NextResponse.json({ error: "validation_failed", message: "video is required" }, { status: 400 });
        const actor: PackageCaptionsActor = { kind: "owner", userId };
        const overwrite = body.overwrite === true;
        if (body.dryRun === true) return NextResponse.json(await deps.preview(channelId, { video: body.video, overwrite }, actor));
        return NextResponse.json(
          await deps.apply(
            channelId,
            {
              video: body.video,
              overwrite,
              ...(typeof body.expectedManifestSha256 === "string" ? { expectedManifestSha256: body.expectedManifestSha256 } : {}),
              // The track the preview showed (null: none to replace); the service requires the key of the owner.
              ...(body.expectedTrackId === null || typeof body.expectedTrackId === "string" ? { expectedTrackId: body.expectedTrackId as string | null } : {}),
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
