import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createWikipediaSignalsCore } from "@/lib/wikipedia-signals";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createWikipediaSignalsCore();

function errorResponse(error: unknown) {
  if (isDomainError(error)) {
    const e = error as DomainError;
    return NextResponse.json({ error: e.code, message: e.message }, { status: getVideoMetadataErrorStatus(e.code) });
  }
  return NextResponse.json(
    { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}

/** Phase 13 slice 13.8 -- the topic's linked Wikipedia articles with their stored daily views. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { topicId } = await params;
    return NextResponse.json({ signals: await core.listTopicSignals(topicId) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Links a Wikipedia article (title or URL) to the topic. Body: `{ article, project? }`. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { article?: unknown; project?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Body must be JSON" }, { status: 400 });
  }
  if (typeof body?.article !== "string" || (body.project !== undefined && typeof body.project !== "string")) {
    return NextResponse.json({ error: "invalid_request", message: "article (string) is required" }, { status: 400 });
  }
  try {
    const { topicId } = await params;
    const link = await core.linkArticle(
      { topicId, article: body.article, project: body.project as string | undefined },
      { createdVia: "web_ui" }
    );
    // Fill the new article's history right away rather than waiting for the next scheduled run.
    await core.collectAll().catch(() => undefined);
    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
