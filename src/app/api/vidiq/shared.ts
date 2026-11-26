import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createVidiqResearchCore, isDomainError, type VidiqResearchCore } from "@/lib/vidiq-research";

// BL-278 (ADR 0077, VIDIQ_INTEGRATION_PLAN.md stage 1): the owner's routes for Settings → Cloud APIs → vidIQ -- the status, the key
// (Mac only: `/api/vidiq/key` is in src/proxy.ts REMOTE_BLOCKED_PREFIXES), the switch and budget, the balance and the drift check.
// Every handler: Web session required (401), a thin call into the one core, DomainError -> status. No answer ever carries the key
// (only its last 4 characters), and a non-domain failure answers a fixed message, never the error's own text (it could quote a
// request). Never reachable from MCP.

export type VidiqRouteCore = Pick<VidiqResearchCore, "getStatus" | "saveKey" | "clearKey" | "updateSettings" | "refreshBalance" | "checkConnection">;

export type VidiqRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: VidiqRouteCore;
};

export function defaultVidiqRouteDeps(): VidiqRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      return createVidiqResearchCore();
    },
  };
}

export function vidiqHandler(deps: VidiqRouteDeps, run: (args: { core: VidiqRouteCore; request: Request }) => Promise<NextResponse>) {
  return async function handler(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core, request });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      console.warn("[vidiq] a Settings request failed with an unexpected error");
      return NextResponse.json({ error: "internal_error", message: "The vidIQ request failed unexpectedly." }, { status: 500 });
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
