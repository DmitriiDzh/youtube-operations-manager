import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiConnectionCore } from "@/lib/ai-connections";
import { DomainError } from "@/lib/ai-connections/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAiConnectionCore();

// Phase 6, AI Connections: global (not channel-scoped) list of configured AI
// provider connections, managed through the Settings UI. Never returns a stored
// credential -- only `hasCredential` (AGENTS.md §F/INV-AIC-1). Not channel-scoped
// because a connection is reusable across any channel's AI Localization workflow
// (consistent with this app's existing single-operator, no-per-user-ownership model,
// docs/TECHNICAL_DEBT.md RISK-02 -- not a new gap introduced here).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const connections = await core.listConnections();
    return NextResponse.json({ connections });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

    const connection = await core.createConnection(body);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
