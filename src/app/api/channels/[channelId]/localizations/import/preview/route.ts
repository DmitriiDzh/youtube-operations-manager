import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { MAX_WORKBOOK_BYTES } from "@/lib/changesets/import";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createChangeSetCore();

// Multipart framing (boundary markers, field headers) adds a small amount of overhead
// on top of the raw file bytes -- this margin avoids rejecting a file that is exactly
// at the limit. This is a best-effort guard: it only helps when the client sends a
// Content-Length header (normal browser multipart uploads do); a chunked request
// without one still gets buffered by request.formData() before parseAndValidateWorkbook's
// own MAX_WORKBOOK_BYTES check runs. See docs/ARCHITECTURE.md §6.12.
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

    const result = await core.previewImport({ channelId, filename, buffer });

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
