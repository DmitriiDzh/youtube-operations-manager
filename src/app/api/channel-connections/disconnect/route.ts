import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
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
    // BL-160 (owner, Telegram 2026-10-09, msgs 2205/2207): disconnecting no longer revokes the channel's agent token. Tokens are
    // shared between devices, so a revocation here would stop the token on every device. It stops working on THIS device anyway
    // (verifyToken requires the channel connected here under the account it was issued for) and works again if the channel is
    // reconnected under that account; Revoke in Settings is the one action that stops it everywhere.
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
