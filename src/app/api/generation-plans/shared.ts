import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, isDomainError, type GenerationPlanServices } from "@/lib/generation-plans";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// BL-143 (ADR 0029): the owner's Web routes for generation plans (Production → Plans). Session required (401); thin
// translation to the plans core; DomainError -> status. Plans are this device's (like every Production route, they are
// not scoped to the active channel); mutating methods pass `src/proxy.ts`'s device gate like every /api route.

export type PlanRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: GenerationPlanServices;
};

export function defaultPlanRouteDeps(): PlanRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      return createGenerationPlansCore();
    },
  };
}

export function planErrorResponse(error: unknown) {
  if (isDomainError(error)) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A handler for `/api/generation-plans/[planId]/...`: 401 without a session; the body (POST) merged under `planId`. */
export function planHandler(
  deps: PlanRouteDeps,
  run: (args: { core: GenerationPlanServices; planId: string; body: Record<string, unknown>; request: Request }) => Promise<unknown>
): (request: Request, context: { params: Promise<{ planId: string }> }) => Promise<NextResponse> {
  return async function handler(request: Request, context: { params: Promise<{ planId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      const body = request.method === "GET" ? {} : await readBody(request);
      return NextResponse.json(await run({ core: deps.core, planId, body, request }));
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}
