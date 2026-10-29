import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createWeeklyBuildCore, type WeeklyBuildService } from "@/lib/weekly-build";

// BL-231 (WEEKLY_BUILD_BUTTON_PLAN.md §4): the owner's routes for the factory's weekly build. Every handler: a Web session (401),
// the channel must be the active one (ADR 0004, 403), a thin call into the module, DomainError -> status. No MCP tool reaches
// them (no-agent.test.ts); mutating methods pass `src/proxy.ts`'s gate like every /api route.

export type WeeklyBuildRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  core: Pick<WeeklyBuildService, "view" | "dryRun" | "start" | "stop">;
};

export function defaultWeeklyBuildRouteDeps(): WeeklyBuildRouteDeps {
  const access = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await access.assertActiveChannel(args);
    },
    // Resolved on first use, so importing a route never builds the core.
    get core() {
      return createWeeklyBuildCore();
    },
  };
}

type RouteContext = { params: Promise<{ channelId: string }> };

export function weeklyBuildHandler(deps: WeeklyBuildRouteDeps, run: (args: { core: WeeklyBuildRouteDeps["core"]; channelId: string; request: Request }) => Promise<Response>) {
  return async function route(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await context.params;
      await deps.assertActiveChannel({ userId, channelId });
      return await run({ core: deps.core, channelId, request });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

/** `{ dates } | { days }`, plus `wake?`; a body that is not a JSON object is an empty one (the module refuses it). */
export async function readBuildBody(request: Request): Promise<{ dates?: unknown; days?: unknown; wake?: unknown }> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as { dates?: unknown; days?: unknown; wake?: unknown }) : {};
  } catch {
    return {};
  }
}
