import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore, recallLiveChannel } from "@/lib/channel-access";
import { getOperationRegistry, isOperationAlreadyRunning, runTrackedOperation } from "@/lib/operation-progress";
import { DomainError } from "@/lib/channel-sync/contracts";
import { createChannelSyncCore, isOwnedChannelCopyFresh } from "@/lib/channel-sync";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../video-metadata/parse-json-body";

const core = createChannelSyncCore();
const channelAccess = createChannelAccessCore();

type ChannelSyncRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelId: (userId: string) => Promise<string | null>;
  /** The channel this process last read live for the identity (`channel-info`'s memo), or null -- never the stored selection. */
  liveChannelId: (userId: string) => string | null;
  storedChannel: (channelId: string) => Promise<{ connectedUserId: string | null; lastSyncedAt: Date | null } | null>;
  /** The full sync, run as the shared `channel-sync` operation (ADR 0015). */
  sync: (args: { userId: string; trackedChannelId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  clock: { now(): Date };
};

/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2988): `onlyIfStale: true` (the dashboard's own automatic sync, `use-connected-channels`)
 * answers `{ skipped: true }` without calling YouTube when the channel this process last read live for the identity (`channel-info`'s
 * memo) has a stored copy owned by this identity and younger than 6 h (`isOwnedChannelCopyFresh`). No live read yet (a fresh sign-in,
 * a restart) means the sync runs. A just-connected channel has no owned copy yet, so it is still synced (and linked)
 * at once (ADR 0010). Without the flag, or with an explicit `channelId`, the sync always runs as before.
 */
export function createChannelSyncHandler(
  deps: ChannelSyncRouteDeps = {
    getSession: () => getServerSession(authOptions),
    activeChannelId: (userId) => channelAccess.getActiveChannelId(userId),
    liveChannelId: (userId) => recallLiveChannel(userId)?.id ?? null,
    storedChannel: (channelId) => createChannelVideoStoreAdapter().getChannel(channelId),
    sync: ({ userId, trackedChannelId, payload }) =>
      runTrackedOperation({
        registry: getOperationRegistry(),
        kind: "channel-sync",
        channelId: trackedChannelId,
        title: "Syncing the channel from YouTube",
        cancellable: false,
        work: (progress) => core.syncChannel({ ...payload, credentialRef: { userId } }, { progress }),
        messageFor: (synced) => `${synced.videoCount} video${synced.videoCount === 1 ? "" : "s"} synced.`,
      }),
    clock: { now: () => new Date() },
  }
) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    try {
      const { onlyIfStale, ...payload } = (await parseVideoMetadataJsonBody(request)) ?? {};

      // Shown in the progress overlay while it runs (ADR 0015). The response below is unchanged. An
      // implicit "my channel" sync has no channel yet on the very first connect -- "unscoped" then.
      const requestedChannelId = typeof payload.channelId === "string" && payload.channelId ? payload.channelId : null;
      const activeChannelId = requestedChannelId ? null : await deps.activeChannelId(userId);

      // The skip rests on the channel this process read live for the identity, never on the stored selection: right after a Google
      // sign-in (which forgets that memo) the selection may still name the previous channel while `channel-info` runs in parallel
      // (review of BL-197), and that new channel must be synced and linked at once (ADR 0010).
      const liveChannelId = onlyIfStale === true && !requestedChannelId ? deps.liveChannelId(userId) : null;
      if (liveChannelId) {
        const stored = await deps.storedChannel(liveChannelId);
        if (isOwnedChannelCopyFresh({ channel: stored, userId, now: deps.clock.now() })) {
          return NextResponse.json({ skipped: true, reason: "fresh", channelId: liveChannelId, lastSyncedAt: stored?.lastSyncedAt?.toISOString() ?? null });
        }
      }

      const trackedChannelId = requestedChannelId ?? activeChannelId ?? "unscoped";
      const result = await deps.sync({ userId, trackedChannelId, payload });

      return NextResponse.json(result);
    } catch (error) {
      if (isOperationAlreadyRunning(error)) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: { operationId: error.operationId } },
          { status: 409 }
        );
      }
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

export const POST = createChannelSyncHandler();
