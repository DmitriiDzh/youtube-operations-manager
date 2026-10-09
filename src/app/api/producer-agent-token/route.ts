import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createProducerTokenCore } from "@/lib/producer-agent-tokens";
import { DomainError } from "@/lib/producer-agent-tokens/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type ProducerTokenRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createProducerTokenCore>, "issueToken" | "revokeToken" | "getActiveToken">;
};

const defaultDeps: ProducerTokenRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createProducerTokenCore(),
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

// BL-161 (docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3) -- operator-only management of the Producer's agent
// token, the same contract as /api/factory-agent-token. The role itself has no Web session and can never
// reach this route. POST returns the plaintext token exactly once; nothing (GET included) can return
// it again. POST and DELETE are mutating methods, so `src/proxy.ts`'s device-availability gate
// covers them.
export function createProducerTokenGetHandler(deps: ProducerTokenRouteDeps = defaultDeps) {
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

export function createProducerTokenPostHandler(deps: ProducerTokenRouteDeps = defaultDeps) {
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

export function createProducerTokenDeleteHandler(deps: ProducerTokenRouteDeps = defaultDeps) {
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

export const GET = createProducerTokenGetHandler();
export const POST = createProducerTokenPostHandler();
export const DELETE = createProducerTokenDeleteHandler();
