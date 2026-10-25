import { z } from "zod";
import { PUBLISHING_PLAN_LIMITS } from "./contracts";

// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 items 3-5): what agents send for a plan, and what the owner sends from the Web UI.
// Strict: an unknown field is refused, so a typo never becomes a silently ignored setting -- and an agent's save has no approval
// or veto field at all (ADR 0051 §6: agents never decide). The rules that are not just the shape are the services'.

const slotId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const channelId = z.string().min(1).max(64);

export const planSlotInputSchema = z
  .object({
    slotId,
    date: day,
    /** Local wall time in the plan's zone. */
    publishAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    lengthHint: z.string().max(PUBLISHING_PLAN_LIMITS.lengthHint).nullable().optional(),
    note: z.string().max(PUBLISHING_PLAN_LIMITS.note).nullable().optional(),
  })
  .strict();

export const savePlanInputSchema = z
  .object({
    channelId,
    weekStart: day,
    timeZone: z.string().min(1).max(64).optional(),
    slots: z.array(planSlotInputSchema).max(PUBLISHING_PLAN_LIMITS.slots).optional(),
    removeSlotIds: z.array(slotId).max(PUBLISHING_PLAN_LIMITS.slots).optional(),
  })
  .strict();
export type SavePlanInput = z.infer<typeof savePlanInputSchema>;

export const getPlanInputSchema = z.object({ channelId, weekStart: day }).strict();
export const listPlansInputSchema = z.object({ channelId }).strict();

/**
 * The owner's decision (Web UI): approve one slot or the week (the slots the screen showed, each with the hash shown), revoke one
 * approved slot, veto or restore one slot.
 */
export const ownerDecisionInputSchema = z
  .object({
    action: z.enum(["approve", "revoke", "veto", "restore"]),
    slots: z
      .array(z.object({ slotId, contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict())
      .min(1)
      .max(PUBLISHING_PLAN_LIMITS.slots),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === "approve" || value.action === "revoke") && value.slots.some((s) => !s.contentHash)) {
      ctx.addIssue({ code: "custom", path: ["slots"], message: "approve and revoke name the content hash each slot was shown with" });
    }
    if ((value.action === "veto" || value.action === "restore" || value.action === "revoke") && value.slots.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["slots"], message: `${value.action} takes exactly one slot` });
    }
  });
export type OwnerDecisionInput = z.infer<typeof ownerDecisionInputSchema>;
