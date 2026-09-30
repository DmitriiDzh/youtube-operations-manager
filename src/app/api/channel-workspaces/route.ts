import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { DomainError } from "@/lib/channel-workspaces/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type ChannelWorkspacesRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createChannelWorkspacesCore>, "listWorkspaces" | "setWorkspace">;
};

const defaultDeps: ChannelWorkspacesRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createChannelWorkspacesCore(),
};

function errorResponse(error: unknown) {
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

// Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- operator-facing only. This is the ONLY place a
// channel's workspace path can be set; agents can read it (MCP `agent_get_channel_workspace`) but
// never set it. Not active-channel-scoped (the Settings "Channels" card manages every connected
// channel at once, like its Activate/Disconnect actions); the service itself refuses any channelId
// that isn't one of this installation's connected channels. PUT is a mutating method, so
// `src/proxy.ts`'s device-availability gate already covers it.
export function createChannelWorkspacesGetHandler(deps: ChannelWorkspacesRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      return NextResponse.json({ workspaces: await deps.core.listWorkspaces() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createChannelWorkspacesPutHandler(deps: ChannelWorkspacesRouteDeps = defaultDeps) {
  return async function PUT(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }

    try {
      return NextResponse.json({ workspace: await deps.core.setWorkspace(body) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createChannelWorkspacesGetHandler();
export const PUT = createChannelWorkspacesPutHandler();
