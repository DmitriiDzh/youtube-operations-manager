import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { isDomainError } from "@/lib/shared-domain";
import { createWeeklyBuildSettingsCore } from "@/lib/weekly-build";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §4): this computer's Python for the factory's weekly build (`{ pythonPath }`, null = find it).

type Settings = ReturnType<typeof createWeeklyBuildSettingsCore>;
export type WeeklyBuildSettingsRouteDeps = { getSession: () => Promise<{ user?: { id?: string | null } } | null>; settings: Settings };

function defaults(): WeeklyBuildSettingsRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get settings() {
      return createWeeklyBuildSettingsCore();
    },
  };
}

function handle(deps: WeeklyBuildSettingsRouteDeps, run: (settings: Settings, request: Request) => Promise<NextResponse>) {
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

export function createWeeklyBuildSettingsGetHandler(deps: WeeklyBuildSettingsRouteDeps = defaults()) {
  return handle(deps, async (settings) => NextResponse.json(await settings.get()));
}

export function createWeeklyBuildSettingsPutHandler(deps: WeeklyBuildSettingsRouteDeps = defaults()) {
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

export const GET = createWeeklyBuildSettingsGetHandler();
export const PUT = createWeeklyBuildSettingsPutHandler();
