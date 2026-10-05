import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { MAX_WORKBOOK_BYTES } from "@/lib/changesets/import";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeSetCore();
const channelAccess = createChannelAccessCore();

// See src/app/api/channels/[channelId]/localizations/import/preview/route.ts for why
// this is a best-effort Content-Length pre-check, not a complete guarantee.
const CONTENT_LENGTH_MARGIN_BYTES = 64 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_WORKBOOK_BYTES + CONTENT_LENGTH_MARGIN_BYTES) {
    return NextResponse.json(
      { error: "validation_failed", message: "Upload exceeds the maximum supported file size" },
      { status: 413 }
    );
  }

  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: "validation_failed", message: "Multipart field 'file' is required" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = "name" in file && typeof file.name === "string" ? file.name : "upload.xlsx";

    const result = await core.createChangeSetFromImport({ channelId, filename, buffer });

    return NextResponse.json(result, { status: 201 });
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
