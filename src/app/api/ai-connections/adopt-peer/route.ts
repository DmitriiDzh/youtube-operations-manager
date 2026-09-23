import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { AI_CONNECTIONS_GLOBAL_DOCUMENT_KEY, createAiConnectionsCatalogSyncRunnerForProduction } from "@/lib/sync-gateway";
import { DomainError } from "@/lib/video-metadata/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const runner = createAiConnectionsCatalogSyncRunnerForProduction();

/**
 * The explicit, operator-triggered "discard my local copy, adopt this peer's version instead"
 * resolution for the global AI-connections catalog, device-wide (no `channelId` -- mirrors
 * `.../change-drafts/adopt-peer` but for the one constant "channel" this family syncs under).
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    const { peerDeviceId } = (body ?? {}) as { peerDeviceId?: unknown };
    if (typeof peerDeviceId !== "string" || peerDeviceId.length === 0) {
      return NextResponse.json(
        { error: "validation_failed", message: "peerDeviceId is required" },
        { status: 400 }
      );
    }

    const result = await runner.adoptDivergentPeer({ channelId: AI_CONNECTIONS_GLOBAL_DOCUMENT_KEY, peerDeviceId });
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
