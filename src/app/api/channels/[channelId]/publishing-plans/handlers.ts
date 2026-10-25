import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPublishingPlansOwnerCore, type PublishingPlansOwnerSurface } from "@/lib/publishing-plans";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../video-metadata/error-status";

// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 items 4 and 6; ADR 0051 §6): the owner's side of the weekly publishing plans -- the list
// with the count waiting for him, one plan, and his decisions (approve one slot or the week, revoke, veto, restore). A Web session
// and the ACTIVE channel are required (AGENTS.md §F); every rule of the decisions is the publishing-plans module's. No MCP path
// reaches these handlers (AC-WP-05 source scan).

export type PublishingPlanRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  service: () => PublishingPlansOwnerSurface;
};

const defaultDeps = (): PublishingPlanRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  // BL-225 stage 2: the slots' package progress from the publishing scan (the composition module; §M).
  service: () => createPublishingPlansOwnerCore(publishingPlanProgress),
});

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

type Params<T> = { params: Promise<T> };
type Base = { channelId: string };

export function createPublishingPlanRouteHandlers(deps: PublishingPlanRouteDeps = defaultDeps()) {
  /** The session's user on the active channel, or the answer to send instead. */
  async function guarded<T extends Base>(context: Params<T>, run: (params: T, userId: string) => Promise<Response>): Promise<Response> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const params = await context.params;
      await deps.assertActiveChannel({ userId, channelId: params.channelId });
      return await run(params, userId);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    /** The channel's plans, newest week first, and how many slots wait for the owner (the tab's badge). */
    list: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().ownerList(channelId))),

    /** One plan with every slot. */
    detail: (_request: Request, context: Params<Base & { weekStart: string }>) =>
      guarded(context, async ({ channelId, weekStart }) => NextResponse.json(await deps.service().ownerGet(channelId, weekStart))),

    /** POST `{ action: approve | revoke | veto | restore, slots: [{ slotId, contentHash? }] }`. */
    decide: (request: Request, context: Params<Base & { weekStart: string }>) =>
      guarded(context, async ({ channelId, weekStart }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().decide(channelId, weekStart, input, userId));
      }),
  };
}
