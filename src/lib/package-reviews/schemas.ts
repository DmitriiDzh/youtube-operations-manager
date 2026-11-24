import { z } from "zod";
import { PACKAGE_REVIEW_LIMITS } from "./contracts";
import { ISSUE_ID, ISSUE_LIMITS, TIMED_COMMENT_CONTROL, TIMED_COMMENT_LIMITS } from "./timed-comments";

// BL-257 (PACKAGE_REVIEW_PLAN.md stage 2): what the owner sends from the Web UI. Strict: an unknown field is refused.

export const manifestSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Owner TG 4846 (AC-IS-04): one action on an existing issue -- resolve it, or follow up with a one-line text (the issue stays open). */
export const issueActionInputSchema = z
  .object({
    issueId: z.string().regex(ISSUE_ID),
    kind: z.enum(["resolved", "follow_up"]),
    text: z.string().max(TIMED_COMMENT_LIMITS.text).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const text = value.text ?? "";
    if (value.kind === "follow_up" && !text.trim()) ctx.addIssue({ code: "custom", path: ["text"], message: "a follow-up needs a text" });
    if (value.kind === "resolved" && value.text !== undefined) ctx.addIssue({ code: "custom", path: ["text"], message: "resolving carries no text" });
    if (TIMED_COMMENT_CONTROL.test(text)) ctx.addIssue({ code: "custom", path: ["text"], message: "one line without control characters" });
  });

/** Owner TG 4817 (AC-TC-01): one comment at a moment of the video -- seconds and a one-line text. */
export const timedCommentInputSchema = z
  .object({
    atSeconds: z.number().finite().min(0).max(TIMED_COMMENT_LIMITS.maxSeconds),
    text: z
      .string()
      .max(TIMED_COMMENT_LIMITS.text)
      .refine((value) => value.trim().length > 0, "a timed comment needs a text")
      .refine((value) => !TIMED_COMMENT_CONTROL.test(value), "one line without control characters"),
  })
  .strict();

/** Owner TG 4817 (AC-TC-03): the owner's whole draft of timed comments for one package (replaced whole; [] clears it). */
export const packageReviewDraftInputSchema = z
  .object({
    manifestSha256: manifestSha256Schema,
    /** Review fix 2: the stored draft this one replaces (its `updatedAt`, null: none). Another stored draft is refused. Absent: no check. */
    baseUpdatedAt: z.string().max(40).nullable().optional(),
    /** Owner TG 4846 (AC-IS-04): his actions on existing issues, kept with the draft until he decides. */
    issueActions: z
      .array(issueActionInputSchema)
      .max(ISSUE_LIMITS.actions)
      .refine((list) => new Set(list.map((a) => a.issueId)).size === list.length, "one action per issue")
      .optional(),
    comments: z
      .array(timedCommentInputSchema.extend({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict())
      .max(TIMED_COMMENT_LIMITS.count)
      .refine((list) => new Set(list.map((c) => c.id)).size === list.length, "comment ids must be unique"),
  })
  .strict();
export type PackageReviewDraftInput = z.infer<typeof packageReviewDraftInputSchema>;

/**
 * The owner's decision: approve the media (a comment optional), return the media (a comment required: what to change), or -- BL-265
 * (ADR 0072 §2) -- a packaging comment (required; it never changes the gate).
 */
export const packageDecisionInputSchema = z
  .object({
    manifestSha256: manifestSha256Schema,
    kind: z.enum(["approved", "returned", "packaging_comment"]),
    comment: z.string().max(PACKAGE_REVIEW_LIMITS.comment).nullable().optional(),
    /** Owner TG 4817 (AC-TC-05): the draft's timed comments, sent with an approval or a return as one batch. */
    timedComments: z.array(timedCommentInputSchema).max(TIMED_COMMENT_LIMITS.count).optional(),
    /**
     * Review fix 1: the draft this decision was made from -- its `updatedAt` as the screen last read it (null: it saw no draft). The
     * stored draft is deleted only when it is that one; another one is refused (`package_review_draft_changed`). Absent: kept.
     */
    draftUpdatedAt: z.string().max(40).nullable().optional(),
    /** Owner TG 4846 (AC-IS-04): the owner's actions on existing issues of this video (resolve, follow up), sent with an approve / return. */
    issueActions: z
      .array(issueActionInputSchema)
      .max(ISSUE_LIMITS.actions)
      .refine((list) => new Set(list.map((a) => a.issueId)).size === list.length, "one action per issue")
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const timed = value.timedComments ?? [];
    // AC-TC-06: a return says what to change -- in a general comment or at moments of the video.
    const followUps = (value.issueActions ?? []).filter((a) => a.kind === "follow_up").length;
    if (value.kind === "returned" && !(value.comment ?? "").trim() && timed.length === 0 && followUps === 0) ctx.addIssue({ code: "custom", path: ["comment"], message: "a return needs a comment, a timed comment or a follow-up" });
    if (value.kind === "packaging_comment" && (value.issueActions ?? []).length > 0) ctx.addIssue({ code: "custom", path: ["issueActions"], message: "a packaging comment carries no issue actions" });
    if (value.kind === "packaging_comment" && timed.length > 0) ctx.addIssue({ code: "custom", path: ["timedComments"], message: "a packaging comment carries no timed comments" });
    if (value.kind === "packaging_comment" && !(value.comment ?? "").trim()) ctx.addIssue({ code: "custom", path: ["comment"], message: "a packaging comment needs a comment" });
    if (CONTROL_CHARACTERS.test(value.comment ?? "")) ctx.addIssue({ code: "custom", path: ["comment"], message: "must not contain control characters" });
  });
export type PackageDecisionInput = z.infer<typeof packageDecisionInputSchema>;

/** The owner's switch: review this channel's final packages before they count as ready. */
export const packageReviewSwitchInputSchema = z.object({ required: z.boolean() }).strict();
