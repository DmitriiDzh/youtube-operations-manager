import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 9G, part B (owner spec §29) -- the ONLY way a research request can move out of
// "pending" into "approved" (see docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §2/§7): a
// human, through this Web-UI-only route, using their own resolved session credentials for the one
// real search.list call this triggers. No MCP tool or CLI command anywhere in this codebase calls
// the underlying action -- verified mechanically by this module's own approval inventory test. A
// real mutation, gated by src/proxy.ts like any other.
export async function POST(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { requestId } = await params;
    const result = await core.approveMarketResearchRequest(
      { requestId, credentialRef: { userId: session.user.id } },
      { createdVia: "web_ui" }
    );
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
