import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageMetadataCore, type PackageMetadataActor } from "@/lib/publishing";
import { isDomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PackageMetadataRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  preview: (channelId: string, input: { video: string }, actor: PackageMetadataActor) => Promise<unknown>;
  apply: (channelId: string, input: { video: string; expectedEtag?: string; expectedManifestSha256?: string; overwrite?: string[] }, actor: PackageMetadataActor) => Promise<unknown>;
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
 * BL-265 (ADR 0072 §5, §8; AGENTS.md §F «Package metadata after upload»): the owner's packaging fix of an uploaded video --
 * `{ video, dryRun? }` previews (every read and check, the three-way diff, no write); `{ video, expectedEtag, expectedManifestSha256, overwrite? }` applies the
 * package's current title / description / tags through video-details (identity check, backup, Live writes, read-back, audit). The
 * owner's session and the active channel only (remote allowed, like the Details card).
 */
export function createPackageMetadataHandlers(
  deps: PackageMetadataRouteDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    preview: (channelId, input, actor) => createPackageMetadataCore().preview(channelId, input, actor),
    apply: (channelId, input, actor) => createPackageMetadataCore().apply(channelId, input, actor),
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
        const actor: PackageMetadataActor = { kind: "owner", userId };
        if (body.dryRun === true) return NextResponse.json(await deps.preview(channelId, { video: body.video }, actor));
        const overwrite = Array.isArray(body.overwrite) ? body.overwrite.filter((f): f is string => typeof f === "string") : [];
        return NextResponse.json(
          await deps.apply(
            channelId,
            {
              video: body.video,
              ...(typeof body.expectedEtag === "string" ? { expectedEtag: body.expectedEtag } : {}),
              // Review fix 2: the manifest the preview showed (the service requires it of the owner).
              ...(typeof body.expectedManifestSha256 === "string" ? { expectedManifestSha256: body.expectedManifestSha256 } : {}),
              overwrite,
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
