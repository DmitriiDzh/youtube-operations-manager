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

const defaults = defaultPlanRouteDeps();
export const POST = createClaimPostHandler({
  getSession: defaults.getSession,
  get core() {
    return defaults.core;
  },
  activeChannelId: defaults.activeChannelId,
  publish: publishGenerationPlansShare,
});
