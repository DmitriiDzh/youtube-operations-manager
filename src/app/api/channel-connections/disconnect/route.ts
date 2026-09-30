import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentTokenCore } from "@/lib/agent-tokens";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

/**
 * Disconnects a stored channel connection (`docs/decisions/0010-persistent-channel-connections.md`).
 * `forceSignOut: true` tells the client to sign out immediately when the disconnected identity is
 * the one behind the live session -- its tokens are gone, so the session can no longer do anything
 * useful, and leaving it in place would surface as confusing "not authenticated" errors on the
 * next action instead of a clean sign-out.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    const { channelId } = (body ?? {}) as { channelId?: unknown };
    if (typeof channelId !== "string" || channelId.length === 0) {
      return NextResponse.json(
        { error: "validation_failed", message: "channelId is required" },
        { status: 400 }
      );
    }

    const result = await createChannelConnectionsCore().disconnectChannel(channelId);
    // Phase 12 (review round 2): disconnecting a channel also revokes its agent token -- the token
    // is already unusable (verifyToken requires a live connection), this just keeps the record honest.
    await createAgentTokenCore().revokeToken({ channelId });
    const forceSignOut = result.disconnectedUserId === session.user.id;
    return NextResponse.json({ ...result, forceSignOut });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }
    return NextResponse.json(
      { error: "disconnect_failed", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
