import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import { logicalPathsErrorResponse, readJsonBody, type LogicalPathsSession } from "../shared";

type LogicalPathValueRouteDeps = {
  getSession: () => Promise<LogicalPathsSession>;
  core: Pick<ReturnType<typeof createLogicalPathsCore>, "setValue">;
};

const defaultDeps: LogicalPathValueRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createLogicalPathsCore(),
};

// Sets or clears THIS device's value of one logical path (owner decision, 2026-10-05: each machine
// configures only its own values). Operator-only; no agent surface can reach it.
export function createLogicalPathValuePutHandler(deps: LogicalPathValueRouteDeps = defaultDeps) {
  return async function PUT(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    try {
      return NextResponse.json({ value: await deps.core.setValue(parsed.body) });
    } catch (error) {
      return logicalPathsErrorResponse(error);
    }
  };
}

export const PUT = createLogicalPathValuePutHandler();
