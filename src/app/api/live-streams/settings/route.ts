import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createLiveStreamsSettingsCore, isDomainError } from "@/lib/live-streams";

// BL-176 (LIVE_STREAMS_PLAN.md §3.12 "Settings → Трансляции"): this computer's live-streams settings -- the module switch
// (on only on the Mac's system service), buffer depth, disk thresholds, encoder, bitrate, alert minutes, ffmpeg folder.

type Settings = ReturnType<typeof createLiveStreamsSettingsCore>;
export type LiveStreamsSettingsRouteDeps = { getSession: () => Promise<{ user?: { id?: string | null } } | null>; settings: Settings };

function defaults(): LiveStreamsSettingsRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get settings() {
      return createLiveStreamsSettingsCore();
    },
  };
}

function handle(deps: LiveStreamsSettingsRouteDeps, run: (settings: Settings, request: Request) => Promise<NextResponse>) {
  return async (request: Request): Promise<NextResponse> => {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run(deps.settings, request);
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export function createLiveStreamsSettingsGetHandler(deps: LiveStreamsSettingsRouteDeps = defaults()) {
  return handle(deps, async (settings) => NextResponse.json(await settings.get()));
}

export function createLiveStreamsSettingsPutHandler(deps: LiveStreamsSettingsRouteDeps = defaults()) {
  return handle(deps, async (settings, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    return NextResponse.json(await settings.update(body));
  });
}

export const GET = createLiveStreamsSettingsGetHandler();
export const PUT = createLiveStreamsSettingsPutHandler();
