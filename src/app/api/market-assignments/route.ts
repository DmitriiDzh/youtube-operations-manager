import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketAssignmentCore } from "@/lib/market-assignments";
import { DomainError } from "@/lib/market-assignments/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type MarketAssignmentsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketAssignmentCore>, "listAssignments" | "setAssignment">;
};

const defaultDeps: MarketAssignmentsRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketAssignmentCore(),
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

// Phase 12 slice 12.4 (docs/roadmap/plans/PHASE_12_PLAN.md, owner decision D1) -- operator-only:
// which channels each globally collected market record is assigned to. Agents never reach this
// route; they only ever see the result of these assignments, narrowed to their own channel.
export function createMarketAssignmentsGetHandler(deps: MarketAssignmentsRouteDeps = defaultDeps) {
  return async function GET(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const recordKind = new URL(request.url).searchParams.get("recordKind");
      return NextResponse.json({ assignments: await deps.core.listAssignments({ recordKind }) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createMarketAssignmentsPutHandler(deps: MarketAssignmentsRouteDeps = defaultDeps) {
  return async function PUT(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    try {
      return NextResponse.json({ assignment: await deps.core.setAssignment(body) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createMarketAssignmentsGetHandler();
export const PUT = createMarketAssignmentsPutHandler();
