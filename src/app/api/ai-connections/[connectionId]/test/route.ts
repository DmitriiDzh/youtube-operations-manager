import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiConnectionCore } from "@/lib/ai-connections";
import { DomainError } from "@/lib/ai-connections/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiConnectionCore();

// AC-CONN-15: explicit, user-triggered only -- this route is the ONLY way to reach
// `testConnection`, and it is a POST (never fired by a GET/prefetch), never called
// from anywhere else in this codebase, never on module load or connection creation.
// The response's `mayIncurCost` tells the caller (the Settings UI) whether this
// specific call could have incurred a real cost, so the UI can warn BEFORE the user
// clicks the button, not just after.
export async function POST(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { connectionId } = await params;
    const result = await core.testConnection({ connectionId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
