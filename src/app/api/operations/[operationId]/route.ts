import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getOperationRegistry } from "@/lib/operation-progress";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";

const channelAccess = createChannelAccessCore();

/** One operation progress. The operation own channel must be the active channel -- an operation id
 * alone never grants a look at another channel work (AGENTS.md section F). */
export async function GET(_request: Request, { params }: { params: Promise<{ operationId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { operationId } = await params;
    const snapshot = getOperationRegistry().get(operationId);
    if (!snapshot) return NextResponse.json({ error: "not_found", message: "Operation not found (it may have expired)" }, { status: 404 });
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId: snapshot.channelId });
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
