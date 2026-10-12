import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/channel-language-defaults/contracts";
import { createChannelLanguageDefaultsCore } from "@/lib/channel-language-defaults";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../../video-metadata/parse-json-body";

const core = createChannelLanguageDefaultsCore();
const channelAccess = createChannelAccessCore();

function errorResponse(error: unknown) {
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

/** The channel's expected language baseline plus the synced videos that deviate from it.
 * Read-only: never a YouTube call. */
export async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    return NextResponse.json(await core.getDeviations({ channelId }));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Sets the baseline fields sent (a field left out is unchanged; `null` clears one); shared with the owner's other computers
 * (BL-178 part B). Never a YouTube call. */
export async function PUT(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const parsedBody = await parseVideoMetadataJsonBody(request);
    const body: Record<string, unknown> = parsedBody && typeof parsedBody === "object" ? parsedBody : {};
    // BL-178 part B (review item 3): only the fields sent change; a field left out keeps its (possibly newly synced) value.
    return NextResponse.json(
      await core.setDefaults({
        channelId,
        ...("defaultLanguage" in body ? { defaultLanguage: body.defaultLanguage ?? null } : {}),
        ...("defaultAudioLanguage" in body ? { defaultAudioLanguage: body.defaultAudioLanguage ?? null } : {}),
      })
    );
  } catch (error) {
    return errorResponse(error);
  }
}
