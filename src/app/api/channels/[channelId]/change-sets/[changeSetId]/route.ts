import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createRetentionCoreForProduction, ManualDeleteRefusedError } from "@/lib/retention";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeSetCore();
const channelAccess = createChannelAccessCore();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string; changeSetId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, changeSetId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const { searchParams } = new URL(request.url);

    const status = searchParams.get("status") ?? undefined;
    const language = searchParams.get("language") ?? undefined;
    const videoId = searchParams.get("videoId") ?? undefined;
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");

    const result = await core.getChangeSet({
      channelId,
      changeSetId,
      status,
      language,
      videoId,
      page: pageParam ? Number(pageParam) : undefined,
      pageSize: pageSizeParam ? Number(pageSizeParam) : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
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

/**
 * Manual deletion of one change set (owner request 2026-10-04), whatever its status. Active-channel scoped like every change-set route; the
 * deletion goes through the same purge as the automatic sweep so it reaches the other devices. Refused (409) while a real write carrying
 * one of its changes is running or unresolved.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; changeSetId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, changeSetId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const result = await createRetentionCoreForProduction().deleteChangeSet({ channelId, changeSetId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ManualDeleteRefusedError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "change_set_not_found" ? 404 : error.code === "change_set_in_use" ? 409 : 500 });
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
