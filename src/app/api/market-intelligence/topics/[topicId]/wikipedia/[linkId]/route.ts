import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isDomainError, type DomainError } from "@/lib/shared-domain";
import { createWikipediaSignalsCore } from "@/lib/wikipedia-signals";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createWikipediaSignalsCore();

/** Phase 13 slice 13.8 -- unlinks one Wikipedia article from its topic. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ topicId: string; linkId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { topicId, linkId } = await params;
    await core.unlinkArticle(linkId, topicId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isDomainError(error)) {
      const e = error as DomainError;
      return NextResponse.json({ error: e.code, message: e.message }, { status: getVideoMetadataErrorStatus(e.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
