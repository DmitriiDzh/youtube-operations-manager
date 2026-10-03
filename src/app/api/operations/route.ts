import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getOperationRegistry } from "@/lib/operation-progress";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../video-metadata/error-status";

const channelAccess = createChannelAccessCore();

/** Operations of the ACTIVE channel (`?channelId=`, required; optional `kind`, `active=1`) -- what a
 * freshly loaded page asks to re-attach its progress overlay. Read-only, in-memory. */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const url = new URL(request.url);
    const channelId = url.searchParams.get("channelId");
    if (!channelId) {
      return NextResponse.json({ error: "validation_failed", message: "channelId is required" }, { status: 400 });
    }
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const operations = getOperationRegistry().list({
      channelId,
      kind: url.searchParams.get("kind") ?? undefined,
      activeOnly: url.searchParams.get("active") === "1",
    });
    return NextResponse.json({ operations });
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
