import { createPublishingPlansUploadCore } from "@/lib/publishing-plans";
import type { SlotDecision } from "@/lib/publishing";

/**
 * BL-225 stage 3 (ADR 0051 §7, AGENTS.md §M): the weekly plan's slot decisions for the uploads, composed at the app layer --
 * publishing and publishing-plans import each other nowhere. Used by the automatic upload (an approved slot gives the upload its
 * date, a vetoed one is skipped) and by the plan schedule (a veto or a re-approval after the upload). Read-only.
 */
export async function planSlotDecisions(channelId: string): Promise<Map<string, SlotDecision>> {
  return createPublishingPlansUploadCore().slotDecisions(channelId);
}
