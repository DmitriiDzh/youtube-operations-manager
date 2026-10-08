import { publishGenerationPlansShare } from "@/lib/generation-plans";
import { defaultPlanRouteDeps, planHandler } from "../../shared";

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-01, AC-WV-06): "being reviewed here" on a track or a wave of this device's plan --
 * `{ scope, itemKey?, attemptRef?, groupId?, release? }`. The report goes out at once (the other computer sees it within the
 * sync delay); a failure to publish never fails the claim.
 */
export const POST = planHandler(defaultPlanRouteDeps(), async ({ core, planId, body }) => {
  const claim = await core.claimReview({ ...body, planId, deviceId: undefined });
  void publishGenerationPlansShare().catch(() => undefined);
  return claim;
});
