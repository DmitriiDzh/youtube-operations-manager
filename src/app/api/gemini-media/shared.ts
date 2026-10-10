import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createGeminiMediaCore, isDomainError, type GeminiMediaCore } from "@/lib/gemini-media";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.8) -- the owner's routes for Settings → Gemini: the key, the switch and limits, the spend and
// the recent jobs. Every handler: Web session required (401), a thin call into the one core, DomainError -> status. No route
// ever returns the key (the core's shapes carry only its last 4 characters). Mutating methods pass `src/proxy.ts`'s
// device-availability gate like every /api route.

export type GeminiRouteCore = Pick<GeminiMediaCore, "getKey" | "setKey" | "testKey" | "clearKey" | "getSettings" | "updateSettings" | "getStatus" | "getJobs">;

export type GeminiRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: GeminiRouteCore;
};

export function defaultGeminiRouteDeps(): GeminiRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    // A process-wide singleton, resolved on first use so importing a route never builds it.
    get core() {
      return createGeminiMediaCore();
    },
  };
}

export function geminiHandler(deps: GeminiRouteDeps, run: (args: { core: GeminiRouteCore; request: Request }) => Promise<NextResponse>) {
  return async function handler(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core, request });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }) };
  }
}
