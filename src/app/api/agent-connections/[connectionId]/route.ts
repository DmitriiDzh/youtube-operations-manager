import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentConnectionsCore } from "@/lib/agent-connections";
import { DomainError } from "@/lib/agent-connections/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAgentConnectionsCore();

// Only `enabled` can be changed after registration (slice 1 has no rename/delete) -- label and id
// are fixed at registration time.
export async function PUT(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { connectionId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }

    // A round-4 independent review found that a JSON body of literal `null` (valid JSON, so the
    // catch above never fires) used to throw a raw TypeError on `body.enabled`, surfacing as a
    // generic 500 instead of a proper validation_failed 400 -- fixed by never dereferencing a
    // field on `body` directly; the whole (possibly non-object) value is merged in and left for
    // `setConnectionEnabled`'s own schema validation to reject cleanly, same as the sibling routes.
    const input = typeof body === "object" && body !== null ? { ...body, id: connectionId } : { id: connectionId };
    const connection = await core.setConnectionEnabled(input);
    return NextResponse.json({ connection });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
