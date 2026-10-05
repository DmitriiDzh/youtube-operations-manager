import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/localization/contracts";
import { createLocalizationCore } from "@/lib/localization";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../../../video-metadata/error-status";

const core = createLocalizationCore();
const channelAccess = createChannelAccessCore();

/** Removes a language from the channel's tracked list. NOT a deletion of any real translation --
 * see `removeTrackedLanguage`'s own doc comment (src/lib/localization/services.ts) for why a
 * language with real data on at least one video stays visible regardless. */
export async function DELETE(
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

    const result = await core.removeTrackedLanguage({
      credentialRef: { userId: session.user.id },
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
