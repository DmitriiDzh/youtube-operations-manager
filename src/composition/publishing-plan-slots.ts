import { createPublishingPlansUploadCore } from "@/lib/publishing-plans";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";
import type { SlotDecision } from "@/lib/publishing";

/**
 * BL-225 stage 3 (ADR 0051 §7, AGENTS.md §M): the weekly plan's slot decisions for the uploads, composed at the app layer --
 * publishing and publishing-plans import each other nowhere. Used by the automatic upload (an approved slot gives the upload its
 * date, a vetoed one is skipped) and by the plan schedule (a veto or a re-approval after the upload). Read-only. BL-242 R1 (ADR
 * 0062 §3): with the same package progress as «План недели», so an approval counts for the uploads only while it covers the slot's
 * current package (a failed read approves nothing).
 */
export async function planSlotDecisions(channelId: string): Promise<Map<string, SlotDecision>> {
  return createPublishingPlansUploadCore(publishingPlanProgress).slotDecisions(channelId);
}
