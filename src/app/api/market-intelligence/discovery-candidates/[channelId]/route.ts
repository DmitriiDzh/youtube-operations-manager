import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 9C -- watch/ignore/archive a candidate. Never accepts "promoted" (that has a real
// side effect and its own dedicated route below) or "new" (the initial state only).
export async function PATCH(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }

    const { channelId } = await params;
    const candidate = await core.updateDiscoveryCandidateStatus({ channelId, status: body.status });
    return NextResponse.json({ candidate });
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
