import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentConnectionsCore } from "@/lib/agent-connections";
import { DomainError } from "@/lib/agent-connections/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAgentConnectionsCore();

// BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- global (not channel-scoped) registry of
// agent connections, managed through the Settings UI. Not channel-scoped: a connection's identity
// is a property of the MCP/CLI client that spawned it, not of any one channel.
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

    const connection = await core.registerConnection(body);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
