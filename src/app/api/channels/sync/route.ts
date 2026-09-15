import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/channel-sync/contracts";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { getVideoMetadataErrorStatus } from "../../video-metadata/error-status";
import { parseVideoMetadataJsonBody } from "../../video-metadata/parse-json-body";

const core = createChannelSyncCore();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await parseVideoMetadataJsonBody(request);

    const result = await core.syncChannel({
      ...payload,
      credentialRef: { userId: session.user.id },
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
