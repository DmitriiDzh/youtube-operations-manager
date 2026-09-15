import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/localization/contracts";
import { createLocalizationCore } from "@/lib/localization";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

const core = createLocalizationCore();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string; videoId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, videoId } = await params;
    const result = await core.getVideoLocalizationDetail({
      credentialRef: { userId: session.user.id },
      channelId,
      videoId,
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
