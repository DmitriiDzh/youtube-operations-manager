import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createGenerationPlansCore, isDomainError, type GenerationPlanServices } from "@/lib/generation-plans";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// BL-143 (ADR 0029): the owner's Web routes for generation plans (Media → Plans). Session required (401); thin
// translation to the plans core; DomainError -> status. Mutating methods pass `src/proxy.ts`'s device gate like every /api
// route. BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): Media is the ACTIVE channel's -- every plan route answers a
// plan of another channel as not found, the channel resolved here on the server, never taken from the request.

export type PlanRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: GenerationPlanServices;
  /** The session's active channel (`users.selectedChannelId`), or null while none is known. */
  activeChannelId: (userId: string) => Promise<string | null>;
};

/** The session's active channel for a plan route (ADR 0004): a plain local lookup, no YouTube call. */
export function activeChannelOf(userId: string): Promise<string | null> {
  return createChannelAccessCore().getActiveChannelId(userId);
}

export function defaultPlanRouteDeps(): PlanRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      return createGenerationPlansCore();
    },
    activeChannelId: activeChannelOf,
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
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      await deps.core.assertPlanOfChannel(planId, await deps.activeChannelId(userId));
      const body = request.method === "GET" ? {} : await readBody(request);
      return NextResponse.json(await run({ core: deps.core, planId, body, request }));
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}
