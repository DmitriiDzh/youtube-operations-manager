import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, DomainError, type MediaGenerationCore } from "@/lib/media-generation";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

// Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- operator-only routes for Settings → Media.
// Every handler: session required (401), thin translation to the one core, DomainError -> status
// map. No route ever returns a stored secret: the core's public shapes carry none (AC-P14-02/21).
// Mutating methods are covered by `src/proxy.ts`'s device-availability gate like every /api route.

export type MediaRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: MediaGenerationCore;
};

let defaultCore: MediaGenerationCore | null = null;

export function defaultMediaRouteDeps(): MediaRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      defaultCore ??= createMediaGenerationCore();
      return defaultCore;
    },
  };
}

export function mediaErrorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }) };
  }
}

/** Wraps a handler: 401 without a session, DomainError mapping, 500 otherwise. */
export function mediaHandler(
  deps: MediaRouteDeps,
  run: (args: { core: MediaGenerationCore; request: Request }) => Promise<NextResponse>
): (request: Request) => Promise<NextResponse> {
  return async function handler(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      return await run({ core: deps.core, request });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
}
