import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createFactoryTokenCore } from "@/lib/factory-agent-tokens";
import { DomainError } from "@/lib/factory-agent-tokens/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type FactoryTokenRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createFactoryTokenCore>, "issueToken" | "revokeToken" | "getActiveToken">;
};

const defaultDeps: FactoryTokenRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createFactoryTokenCore(),
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

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F2) -- operator-only
// management of the Factory Operator's agent token. The role itself has no Web session and can never
// reach this route. POST returns the plaintext token exactly once; nothing (GET included) can return
// it again. POST and DELETE are mutating methods, so `src/proxy.ts`'s device-availability gate
// covers them.
export function createFactoryTokenGetHandler(deps: FactoryTokenRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return NextResponse.json({ token: await deps.core.getActiveToken() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createFactoryTokenPostHandler(deps: FactoryTokenRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }
    }
    try {
      const issued = await deps.core.issueToken(body);
      return NextResponse.json({ token: issued }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createFactoryTokenDeleteHandler(deps: FactoryTokenRouteDeps = defaultDeps) {
  return async function DELETE() {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return NextResponse.json(await deps.core.revokeToken());
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createFactoryTokenGetHandler();
export const POST = createFactoryTokenPostHandler();
export const DELETE = createFactoryTokenDeleteHandler();
