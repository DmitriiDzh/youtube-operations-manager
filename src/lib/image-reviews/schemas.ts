import { z } from "zod";
import { IMAGE_REVIEW_LIMITS } from "./contracts";

// BL-272 (ADR 0076): what the Producer sends and what the owner sends from the Web UI. Strict: an unknown field is refused, so a
// Producer submit can never carry a status or a decision. The rules beyond the shape are the services'.

const channelId = z.string().min(1).max(64);
export const imageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** The Producer's own keys (batch, request): letters, digits and `_ - . :`. */
const key = z.string().regex(new RegExp(`^[A-Za-z0-9_.:-]{1,${IMAGE_REVIEW_LIMITS.key}}$`));
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

export const submitImageInputSchema = z
  .object({
    channelId,
    sceneId: text(IMAGE_REVIEW_LIMITS.sceneId, false),
    imagePath: z.string().min(1).max(IMAGE_REVIEW_LIMITS.imagePath),
    note: text(IMAGE_REVIEW_LIMITS.note, true).optional(),
    batchId: key.optional(),
    requestId: key.optional(),
  })
  .strict();
export type SubmitImageInput = z.infer<typeof submitImageInputSchema>;

export const listImagesInputSchema = z
  .object({
    channelId,
    status: z.enum(["pending", "approved", "approved_with_note", "returned", "withdrawn"]).optional(),
    batchId: key.optional(),
    limit: z.number().int().min(1).max(IMAGE_REVIEW_LIMITS.listMax).optional(),
  })
  .strict();

export const getImageInputSchema = z.object({ channelId, imageId: imageIdSchema }).strict();
export const withdrawImageInputSchema = z.object({ channelId, imageId: imageIdSchema }).strict();

/**
 * The owner's decision (Web UI): approve (no comment), approve with a note (the note required: "убрать прохожего") or return (a
 * comment required: what to change).
 */
export const ownerImageDecisionInputSchema = z
  .object({
    action: z.enum(["approve", "approve_with_note", "return"]),
    comment: z.string().max(IMAGE_REVIEW_LIMITS.comment).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const comment = (value.comment ?? "").trim();
    if (value.action !== "approve" && !comment) ctx.addIssue({ code: "custom", path: ["comment"], message: `${value.action} needs a comment` });
    if (value.action === "approve" && comment) ctx.addIssue({ code: "custom", path: ["comment"], message: "a plain approval has no comment (approve_with_note carries one)" });
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(comment)) ctx.addIssue({ code: "custom", path: ["comment"], message: "must not contain control characters" });
  });
export type OwnerImageDecisionInput = z.infer<typeof ownerImageDecisionInputSchema>;
