import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentOperationsCore } from "@/lib/agent-operations";
import { DomainError } from "@/lib/agent-operations/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAgentOperationsCore();

// Phase 7 (Agent Operations Interface, docs/AGENT_OPERATIONS_INTERFACE.md) slice A -- the same
// service function the MCP tool `agent_get_capabilities` calls, exposed as an equivalent HTTP
// contract per the design's own "prefer MCP, expose equivalent HTTP where useful, never two
// independent implementations" requirement. No channel scoping (instance-level information);
// gated the same way every other route in this app is, by a valid NextAuth session.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await core.getSystemCapabilities({});
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
