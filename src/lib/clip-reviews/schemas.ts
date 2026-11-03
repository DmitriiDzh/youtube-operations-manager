import { z } from "zod";
import { CLIP_REVIEW_LIMITS } from "./contracts";

// BL-241 (CLIP_REVIEWS_PLAN.md items 2-6): what the Producer sends and what the owner sends from the Web UI. Strict: an unknown field
// is refused, so a Producer submit can never carry a status or a decision (ADR 0061 §4). The rules beyond the shape are the services'.

const channelId = z.string().min(1).max(64);
export const clipIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** Trimmed, at least one character, no control characters (a line break is allowed in a note or comment). */
const text = (max: number, allowLineBreaks: boolean) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !(allowLineBreaks ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), { message: "must not contain control characters" })
    );
const seconds = z.number().finite().min(0);

export const submitClipInputSchema = z
  .object({
    channelId,
    sceneId: text(CLIP_REVIEW_LIMITS.sceneId, false),
    clipPath: z.string().min(1).max(CLIP_REVIEW_LIMITS.clipPath),
    note: text(CLIP_REVIEW_LIMITS.note, true),
    startSec: seconds.optional(),
    endSec: seconds.optional(),
  })
  .strict();
export type SubmitClipInput = z.infer<typeof submitClipInputSchema>;

export const listClipsInputSchema = z
  .object({
    channelId,
    status: z.enum(["pending", "approved", "returned", "withdrawn"]).optional(),
    limit: z.number().int().min(1).max(CLIP_REVIEW_LIMITS.listMax).optional(),
  })
  .strict();

export const getClipInputSchema = z.object({ channelId, clipId: clipIdSchema }).strict();
export const withdrawClipInputSchema = z.object({ channelId, clipId: clipIdSchema }).strict();

/** The owner's decision (Web UI): approve (a comment optional) or return (a comment required: what to change). */
export const ownerClipDecisionInputSchema = z
  .object({
    action: z.enum(["approve", "return"]),
    comment: z.string().max(CLIP_REVIEW_LIMITS.comment).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "return" && !(value.comment ?? "").trim()) ctx.addIssue({ code: "custom", path: ["comment"], message: "a return needs a comment" });
  });
export type OwnerClipDecisionInput = z.infer<typeof ownerClipDecisionInputSchema>;
