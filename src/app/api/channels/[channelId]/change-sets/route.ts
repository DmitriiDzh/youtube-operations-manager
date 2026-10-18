import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createSendApprovedCore } from "@/lib/batches";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeSetCore();
const channelAccess = createChannelAccessCore();
const sendCore = createSendApprovedCore();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const changeSets = await core.listChangeSets({ channelId });
    // BL-198 (AC-ST-12): how many approved changes of each set are already on YouTube -- «Записаны в YouTube» when all of them,
    // «Одобренные» (waiting to be sent) otherwise. Additive field.
    // Only decided sets can be written; a failure here never hides the list (AGENTS.md §M): the field is then left out.
    const decided = changeSets.filter((changeSet) => changeSet.status === "approved" || changeSet.status === "partially_approved");
    const written = await sendCore.writtenCountsByChangeSet(channelId, decided.map((changeSet) => changeSet.id)).catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", event: "change_sets.written_count_failed", context: { channelId, error: error instanceof Error ? error.message : String(error) } }));
      return null;
    });
    return NextResponse.json({
      changeSets: changeSets.map((changeSet) => {
        const counts = written?.get(changeSet.id);
        return counts ? { ...changeSet, writtenCount: counts.writtenCount } : changeSet;
      }),
    });
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
