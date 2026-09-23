import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createEditorialProfileSyncRunnerForProduction } from "@/lib/sync-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";
import { DomainError } from "@/lib/video-metadata/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const runner = createEditorialProfileSyncRunnerForProduction();
const channelAccess = createChannelAccessCore();

/**
 * The explicit, operator-triggered "discard my local copy, adopt this peer's version instead"
 * resolution for an editorial profile whose document diverged from a specific peer's
 * (`divergent_document_lineage`, surfaced in the Merge tab's `peersSkipped` list). Mirrors
 * `.../change-drafts/adopt-peer`'s own route exactly -- the generic capability behind it lives in
 * `automerge-core/sync-runner.ts`'s `adoptDivergentPeer` (generalized 2026-09-23 from
 * `change-drafts-sync`'s own bespoke implementation, `AGENTS.md` §M).
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

    const result = await runner.adoptDivergentPeer({ channelId, peerDeviceId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }
    return NextResponse.json(
      { error: "adopt_peer_failed", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 409 }
    );
  }
}
