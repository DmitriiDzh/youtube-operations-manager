import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPublishingPlansOwnerCore, type PublishingPlansOwnerSurface } from "@/lib/publishing-plans";
import { weekPublishingCoverage } from "@/composition/publishing-coverage";
import { publishingPlanMoveYoutube } from "@/composition/publishing-plan-moves";
import type { PublishingCoverageResult } from "@/lib/publishing-coverage";
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
  /**
   * BL-235 (owner msgs 3806/3807): what YouTube shows for the plan's week -- each day covered / missing translations / gap, from the
   * shared coverage in the plan's zone. Shown next to the approvals; decides nothing. Absent or failing: `coverage: null`.
   */
  coverage?: (channelId: string, weekStart: string, timeZone: string) => Promise<PublishingCoverageResult>;
};

const defaultDeps = (): PublishingPlanRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  // BL-225 stage 2: the slots' package progress from the publishing scan (the composition module; §M).
  // BL-267: the move's YouTube side (plan-schedule's explicit change through video-details), composed outside the plan module.
  service: () => createPublishingPlansOwnerCore(publishingPlanProgress, publishingPlanMoveYoutube()),
  coverage: weekPublishingCoverage,
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

    /** One plan with every slot, and (BL-235) the week's coverage on YouTube -- null when it could not be read. */
    detail: (_request: Request, context: Params<Base & { weekStart: string }>) =>
      guarded(context, async ({ channelId, weekStart }) => {
        const { plan } = await deps.service().ownerGet(channelId, weekStart);
        const coverage = deps.coverage ? await deps.coverage(channelId, weekStart, plan.timeZone).catch(() => null) : null;
        return NextResponse.json({ plan, coverage });
      }),

    /**
     * BL-242 (ADR 0062 §1): POST `{ stage: packaged | slot }` -- the channel's approval stage (the switch «Одобрять пустые слоты»),
     * synced to the other computer, audited here. The owner's only; no MCP path reaches it.
     */
    setApprovalStage: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().setApprovalStage(channelId, input, userId));
      }),

    /** POST `{ action: approve | revoke | veto | restore, slots: [{ slotId, contentHash? }] }`. */
    decide: (request: Request, context: Params<Base & { weekStart: string }>) =>
      guarded(context, async ({ channelId, weekStart }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().decide(channelId, weekStart, input, userId));
      }),

    /**
     * BL-256 (owner msgs 4380/4383): POST `{ slotId, contentHash, date, publishAt, approve }` -- the owner moves a slot to another day
     * of its week and/or another time, approving the new time in the same step when `approve`. Remote access allowed (a session).
     */
    /**
     * BL-267 (ADR 0073 §5): POST `{ slotId, contentHash, toWeekStart, date, publishAt, dryRun? }` -- the owner moves a slot anywhere
     * (any week, on or off the template); a dated video's date moves on YouTube at once. `dryRun` describes the change only.
     */
    move: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().move(channelId, input, userId));
      }),

    /** BL-267 (ADR 0073 §1): the template in force, the pending proposal and the match rules. */
    templateGet: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }) => NextResponse.json(await deps.service().templateGet(channelId))),

    /** BL-267: POST `{ template, basedOn? }` -- the owner's edit: a new version approved in the same change. */
    templateSave: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().templateOwnerSave(channelId, input, userId));
      }),

    /** BL-267: POST `{ action: accept | reject, versionId, contentHash }` -- the owner decides a proposal. */
    templateDecide: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().templateOwnerDecide(channelId, input, userId));
      }),

    /** BL-267 (AC-WT-28): POST `{ template }` -- which slots a template would start or stop dating (read-only, for the dialog). */
    templateEffect: (request: Request, context: Params<Base>) =>
      guarded(context, async ({ channelId }) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().templateEffect(channelId, input));
      }),

    /** BL-267: POST -- «Даты по шаблону» off. */
    templateWithdraw: (_request: Request, context: Params<Base>) => guarded(context, async ({ channelId }, userId) => NextResponse.json(await deps.service().templateOwnerWithdraw(channelId, userId))),

    retime: (request: Request, context: Params<Base & { weekStart: string }>) =>
      guarded(context, async ({ channelId, weekStart }, userId) => {
        const input = await request.json().catch(() => null);
        return NextResponse.json(await deps.service().retime(channelId, weekStart, input, userId));
      }),
  };
}
