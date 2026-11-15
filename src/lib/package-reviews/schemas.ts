import { z } from "zod";
import { PACKAGE_REVIEW_LIMITS } from "./contracts";

// BL-257 (PACKAGE_REVIEW_PLAN.md stage 2): what the owner sends from the Web UI. Strict: an unknown field is refused.

export const manifestSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** The owner's decision: approve (a comment optional) or return (a comment required: what to change). */
export const packageDecisionInputSchema = z
  .object({
    manifestSha256: manifestSha256Schema,
    kind: z.enum(["approved", "returned"]),
    comment: z.string().max(PACKAGE_REVIEW_LIMITS.comment).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "returned" && !(value.comment ?? "").trim()) ctx.addIssue({ code: "custom", path: ["comment"], message: "a return needs a comment" });
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value.comment ?? "")) ctx.addIssue({ code: "custom", path: ["comment"], message: "must not contain control characters" });
  });
export type PackageDecisionInput = z.infer<typeof packageDecisionInputSchema>;

/** The owner's switch: review this channel's final packages before they count as ready. */
export const packageReviewSwitchInputSchema = z.object({ required: z.boolean() }).strict();
