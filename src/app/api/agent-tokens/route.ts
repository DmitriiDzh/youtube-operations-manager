import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentTokenCore } from "@/lib/agent-tokens";
import { DomainError } from "@/lib/agent-tokens/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type AgentTokensRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createAgentTokenCore>, "issueToken" | "revokeToken" | "listActiveTokens">;
};

const defaultDeps: AgentTokensRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createAgentTokenCore(),
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

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }),
    };
  }
}

// Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md slice 12.1) -- operator-only management of
// channel-bound agent tokens. Agents never reach this route (they have no Web session). POST
// returns the plaintext token exactly once; nothing (GET included) can return it again. POST and
// DELETE are mutating methods, so `src/proxy.ts`'s device-availability gate covers them.
export function createAgentTokensGetHandler(deps: AgentTokensRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return NextResponse.json({ tokens: await deps.core.listActiveTokens() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createAgentTokensPostHandler(deps: AgentTokensRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    try {
      const issued = await deps.core.issueToken(parsed.body);
      return NextResponse.json({ token: issued }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createAgentTokensDeleteHandler(deps: AgentTokensRouteDeps = defaultDeps) {
  return async function DELETE(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    try {
      return NextResponse.json(await deps.core.revokeToken(parsed.body));
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createAgentTokensGetHandler();
export const POST = createAgentTokensPostHandler();
export const DELETE = createAgentTokensDeleteHandler();
