import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/localization/contracts";
import { createLocalizationCore } from "@/lib/localization";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../../../video-metadata/parse-json-body";

const core = createLocalizationCore();
const channelAccess = createChannelAccessCore();

/** Adds a language to the channel's tracked list (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md
 * §7.2/E5) -- a local display preference only, never a YouTube call. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const body = await parseVideoMetadataJsonBody(request);

    const result = await core.addTrackedLanguage({
      credentialRef: { userId: session.user.id },
      channelId,
      language: body.language,
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
