import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { DomainError } from "@/lib/decision-engine/contracts";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { createRealEvidenceReferenceResolver } from "@/app/api/decision-engine/evidence-reference-resolver";

const decisionEngineCore = createDecisionEngineCore();
const evidenceResolver = createRealEvidenceReferenceResolver({
  analyticsCore: createAnalyticsCore(),
  marketIntelligenceCore: createMarketIntelligenceCore(),
});

export async function GET(request: Request, { params }: { params: Promise<{ hypothesisId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { hypothesisId } = await params;
    const evidence = await decisionEngineCore.listHypothesisEvidence(hypothesisId, { userId: session.user.id });
    return NextResponse.json({ evidence });
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

export async function POST(request: Request, { params }: { params: Promise<{ hypothesisId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    const { hypothesisId } = await params;
    const evidence = await decisionEngineCore.addHypothesisEvidence(
      hypothesisId,
      body,
      { userId: session.user.id, createdVia: "web_ui" },
      evidenceResolver
    );
    return NextResponse.json({ evidence }, { status: 201 });
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
