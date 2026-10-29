import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createElevenlabsSpeechCore, isDomainError, type ElevenlabsSpeechCore } from "@/lib/elevenlabs-speech";

// BL-236 (ADR 0057) -- the owner's routes for Settings → Cloud APIs → ElevenLabs: the key, the switch, the character limits, the
// output format and the usage. Every handler: Web session required (401), a thin call into the one core, DomainError -> status. No
// route ever returns the key (only its last 4 characters). Never reachable from MCP.

export type ElevenlabsRouteCore = Pick<ElevenlabsSpeechCore, "getKey" | "setKey" | "testKey" | "clearKey" | "getSettings" | "updateSettings" | "getStatus" | "getJobs" | "getSettingsSyncStatus" | "peekSettingsSync" | "resolveSettingConflict">;

export type ElevenlabsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: ElevenlabsRouteCore;
};

export function defaultElevenlabsRouteDeps(): ElevenlabsRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      return createElevenlabsSpeechCore();
    },
  };
}

export function elevenlabsHandler(deps: ElevenlabsRouteDeps, run: (args: { core: ElevenlabsRouteCore; request: Request }) => Promise<NextResponse>) {
  return async function handler(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core, request });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
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
