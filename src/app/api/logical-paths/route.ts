import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import { logicalPathsErrorResponse, readJsonBody, type LogicalPathsSession } from "./shared";

type LogicalPathsRouteDeps = {
  getSession: () => Promise<LogicalPathsSession>;
  core: Pick<ReturnType<typeof createLogicalPathsCore>, "listForOperator" | "createPath" | "deletePath">;
};

const defaultDeps: LogicalPathsRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createLogicalPathsCore(),
};

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F1) -- operator-facing
// only. This is the ONLY place a logical path can be defined or removed; agents can read paths
// (later slices) but never create, change or delete them. Not channel-scoped: the registry is
// device-wide. POST/DELETE are mutating methods, so `src/proxy.ts`'s device-availability gate
// already covers them.
export function createLogicalPathsGetHandler(deps: LogicalPathsRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      return NextResponse.json({ paths: await deps.core.listForOperator() });
    } catch (error) {
      return logicalPathsErrorResponse(error);
    }
  };
}

export function createLogicalPathsPostHandler(deps: LogicalPathsRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    try {
      return NextResponse.json({ path: await deps.core.createPath(parsed.body) }, { status: 201 });
    } catch (error) {
      return logicalPathsErrorResponse(error);
    }
  };
}

export function createLogicalPathsDeleteHandler(deps: LogicalPathsRouteDeps = defaultDeps) {
  return async function DELETE(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    try {
      return NextResponse.json({ path: await deps.core.deletePath(parsed.body) });
    } catch (error) {
      return logicalPathsErrorResponse(error);
    }
  };
}

export const GET = createLogicalPathsGetHandler();
export const POST = createLogicalPathsPostHandler();
export const DELETE = createLogicalPathsDeleteHandler();
