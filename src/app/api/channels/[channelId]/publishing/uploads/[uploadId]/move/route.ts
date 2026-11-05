import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createUploadQueueControlCore } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../../../video-metadata/error-status";
import { deviceGateErrorResponse } from "../../device-gate-error";

export type MoveUploadDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  moveStep: (input: { channelId: string; uploadId: string; direction: "up" | "down" }, userId: string) => Promise<Record<string, unknown>>;
};

/**
 * BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md §6, owner msg 3930): the owner's ↑ / ↓ on a queued upload -- one place in this computer's
 * shared queue (every channel). Only a `queued` row moves (409 otherwise); the active channel only; audited `by: owner`.
 */
export function createMoveUploadHandler(
  deps: MoveUploadDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    moveStep: (input, userId) => createUploadQueueControlCore().moveStep(input, { kind: "owner", userId }),
  }
) {
  return async function POST(request: Request, { params }: { params: Promise<{ channelId: string; uploadId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, uploadId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      const body = (await request.json().catch(() => null)) as { direction?: unknown } | null;
      const direction = body?.direction;
      if (direction !== "up" && direction !== "down") return NextResponse.json({ error: "validation_failed", message: "direction must be up or down" }, { status: 400 });
      return NextResponse.json(await deps.moveStep({ channelId, uploadId, direction }, userId));
    } catch (error) {
      const gate = deviceGateErrorResponse(error);
      if (gate) return gate;
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createMoveUploadHandler();
