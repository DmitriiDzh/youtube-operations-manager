import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../../../../video-metadata/error-status";

const core = createChangeSetCore();
const channelAccess = createChannelAccessCore();

/**
 * E5b (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2) -- proposes deleting one language's
 * localization from every video on the channel that has a real one (`videoIds` omitted). This is
 * only ever a PROPOSAL: it creates a source:"deletion" Change Set that still needs approval and,
 * once Gate B is eventually cleared, an explicit Batch execution -- nothing here writes to
 * YouTube. See `changesets.proposeLocalizationDeletion`'s own doc comment for the full safety
 * model (defaultLanguage exclusion, the skipped-videos report).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; language: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, language } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

    const result = await core.proposeLocalizationDeletion({
      channelId,
      language: decodeURIComponent(language),
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
