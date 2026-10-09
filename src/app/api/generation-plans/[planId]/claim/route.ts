import { NextResponse } from "next/server";
import { publishGenerationPlansShare, type GenerationPlanServices } from "@/lib/generation-plans";
import { defaultPlanRouteDeps, planErrorResponse, type PlanRouteDeps } from "../../shared";

export type ClaimRouteDeps = Omit<PlanRouteDeps, "core"> & { core: Pick<GenerationPlanServices, "assertPlanOfChannel" | "claimReview">; publish: () => Promise<void> };

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-01, AC-WV-06): "being reviewed here" on a track or a wave of this device's plan --
 * `{ scope, itemKey?, attemptRef?, groupId?, release? }`. A claim is only for the active channel's plan (AC-SM-03); a release
 * only removes this device's own claim, so it needs no channel (it must work right after a channel switch -- review round 2).
 * The report goes out at once; a failure to publish never fails the claim.
 */
export function createClaimPostHandler(deps: ClaimRouteDeps) {
  return async function POST(request: Request, context: { params: Promise<{ planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      const raw: unknown = await request.json().catch(() => ({}));
      const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (body.release !== true) await deps.core.assertPlanOfChannel(planId, await deps.activeChannelId(userId));
      const claim = await deps.core.claimReview({ ...body, planId, deviceId: undefined });
      void deps.publish().catch(() => undefined);
      return NextResponse.json(claim);
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

/**
 * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.4): the other computers' live claims on this device's plan, for the review screen's quick
 * poll (every few seconds, without reloading the queue). Only the active channel's plan (AC-SM-03).
 */
export function createClaimGetHandler(deps: Omit<PlanRouteDeps, "core"> & { core: Pick<GenerationPlanServices, "assertPlanOfChannel" | "liveClaims"> }) {
  return async function GET(_request: Request, context: { params: Promise<{ planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { planId } = await context.params;
      await deps.core.assertPlanOfChannel(planId, await deps.activeChannelId(userId));
      return NextResponse.json({ claims: await deps.core.liveClaims({ planId }) });
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

const defaults = defaultPlanRouteDeps();
export const GET = createClaimGetHandler({
  getSession: defaults.getSession,
  get core() {
    return defaults.core;
  },
  activeChannelId: defaults.activeChannelId,
});
export const POST = createClaimPostHandler({
  getSession: defaults.getSession,
  get core() {
    return defaults.core;
  },
  activeChannelId: defaults.activeChannelId,
  publish: publishGenerationPlansShare,
});
