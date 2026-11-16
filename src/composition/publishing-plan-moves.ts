import { createPlanMoveYoutubeCore } from "@/lib/publishing";
import { createPublishingPlansProducerCore, type PlanMoveYoutubePort } from "@/lib/publishing-plans";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";
import { planSlotDecisions } from "./publishing-plan-slots";

/**
 * BL-267 (ADR 0073 §5, plan §3.7; AGENTS.md §M): the YouTube side of an explicit move, composed at the app layer -- publishing-plans
 * never imports publishing or video-details. Given to the owner's and the Producer's plan surfaces only (no worker or factory path).
 */
export function publishingPlanMoveYoutube(): PlanMoveYoutubePort {
  const core = createPlanMoveYoutubeCore({ slotDecisions: planSlotDecisions });
  return { precheck: (channelId, videoId) => core.precheck(channelId, videoId), write: (channelId, videoId, slotId, at, by) => core.write(channelId, videoId, slotId, at, by) };
}

/** BL-267 (ADR 0073 §5, plan §3.10): the Producer's plan surface -- reads, its template proposal and its immediate move. */
export function producerPublishingPlans() {
  return createPublishingPlansProducerCore(publishingPlanProgress, publishingPlanMoveYoutube());
}
