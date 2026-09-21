import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChangeDraftsSyncCoreForProduction } from "@/lib/change-drafts-sync";
import { createChannelAccessCore } from "@/lib/channel-access";
import { DomainError } from "@/lib/video-metadata/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeDraftsSyncCoreForProduction();
const channelAccess = createChannelAccessCore();

/**
 * RISK-46 (docs/TECHNICAL_DEBT.md): the explicit, operator-triggered "discard my local copy,
 * adopt this peer's version instead" resolution for a channel whose document diverged from a
 * specific peer's (`divergent_document_lineage`, surfaced in the Merge tab's `peersSkipped`
 * list). A real, destructive mutation -- gated by `src/proxy.ts`'s device-availability lock like
 * any other write (this route is not in its exempt list), and channel-scoped per
 * `docs/DEVELOPMENT_PLAYBOOK.md` §6.6(b) since `channelId` comes from the client (a URL path
 * parameter), unlike the device-wide `/api/change-drafts/*` routes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    const body: unknown = await request.json();
    const { peerDeviceId } = (body ?? {}) as { peerDeviceId?: unknown };
    if (typeof peerDeviceId !== "string" || peerDeviceId.length === 0) {
      return NextResponse.json(
        { error: "validation_failed", message: "peerDeviceId is required" },
        { status: 400 }
      );
    }

    const result = await core.adoptDivergentPeer({ channelId, peerDeviceId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }
    // adoptDivergentPeer's own plain `Error`s (peer file not found, sync folder unavailable,
    // another adoption already in progress) are real, expected outcomes, not internal failures --
    // 409 (conflict-with-current-state) fits all three better than a bare 500.
    return NextResponse.json(
      { error: "adopt_peer_failed", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 409 }
    );
  }
}
