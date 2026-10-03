import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getOperationRegistry, isOperationAlreadyRunning, runTrackedOperation } from "@/lib/operation-progress";
import { DomainError } from "@/lib/channel-sync/contracts";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../video-metadata/parse-json-body";

const core = createChannelSyncCore();
const channelAccess = createChannelAccessCore();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await parseVideoMetadataJsonBody(request);

    // Shown in the progress overlay while it runs (ADR 0015). The response below is unchanged. An
    // implicit "my channel" sync has no channel yet on the very first connect -- "unscoped" then.
    const requestedChannelId = typeof payload.channelId === "string" && payload.channelId ? payload.channelId : null;
    const trackedChannelId = requestedChannelId ?? (await channelAccess.getActiveChannelId(session.user.id)) ?? "unscoped";

    const result = await runTrackedOperation({
      registry: getOperationRegistry(),
      kind: "channel-sync",
      channelId: trackedChannelId,
      title: "Syncing the channel from YouTube",
      cancellable: false,
      work: (progress) =>
        core.syncChannel({ ...payload, credentialRef: { userId: session.user.id } }, { progress }),
      messageFor: (synced) => `${synced.videoCount} video${synced.videoCount === 1 ? "" : "s"} synced.`,
    });

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
}
