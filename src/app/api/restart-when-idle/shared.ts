import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createRestartWhenIdleCore, type RestartWhenIdle } from "@/lib/restart-when-idle";
import { isDomainError } from "@/lib/shared-domain";

// BL-220 (RESTART_WHEN_IDLE_PLAN.md, ADR 0049): the owner's routes for «Перезапуск, когда никто не работает» (Settings → О программе).
// Every handler: a Web session (401), a thin call into the module, DomainError -> status. Mutating methods pass `src/proxy.ts`'s
// device mutation gate like every /api route. The owner acts as `owner`: any hold can be ended, the open request cancelled.

export type RestartRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => Pick<RestartWhenIdle, "status" | "request" | "cancel" | "setQuietMinutes" | "releaseHold">;
};

export function defaultRestartRouteDeps(): RestartRouteDeps {
  return { getSession: () => getServerSession(authOptions), core: createRestartWhenIdleCore };
}

type Run<C> = (args: { core: ReturnType<RestartRouteDeps["core"]>; request: Request; context: C }) => Promise<NextResponse>;

export function restartHandler<C = unknown>(deps: RestartRouteDeps, run: Run<C>) {
  return async function handler(request: Request, context: C): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core(), request, context });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const invalidBody = () => NextResponse.json({ error: "validation_failed", message: "Request body must be a JSON object" }, { status: 400 });

export function createRestartHandlers(deps: RestartRouteDeps) {
  return {
    /** `{ request, waitingFor, holds, lastRestart, quietMinutes, serviceMode }` (local reads). */
    GET: restartHandler(deps, async ({ core }) => NextResponse.json(await core.status())),
    /** The owner's button: opens a request or joins the open one; 409 restart_needs_service outside the system service. */
    POST: restartHandler(deps, async ({ core }) => NextResponse.json(await core.request("owner"))),
    /** Cancels the open request; 404 not_found when there is none. */
    DELETE: restartHandler(deps, async ({ core }) => NextResponse.json(await core.cancel())),
    /** `{ quietMinutes }` -- 1-30 (400 validation_failed otherwise). */
    PUT_SETTINGS: restartHandler(deps, async ({ core, request }) => {
      const body = await jsonBody(request);
      if (!body) return invalidBody();
      return NextResponse.json(await core.setQuietMinutes(body.quietMinutes));
    }),
    /** Ends any hold (the owner may end every hold); 404 not_found for an unknown one. */
    DELETE_HOLD: restartHandler<{ params: Promise<{ holdId: string }> }>(deps, async ({ core, context }) => {
      const { holdId } = await context.params;
      return NextResponse.json(await core.releaseHold({ holdId, by: "owner" }));
    }),
  };
}
