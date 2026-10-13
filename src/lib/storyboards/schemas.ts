import { z } from "zod";

// BL-184 (FO-REQ-0024 §4 B1, C; docs/roadmap/plans/STORYBOARD_PLAN.md §2): what the Operator sends for a storyboard, and what the
// owner sends from the Web UI. Strict: an unknown field is refused, so a typo never becomes a silently ignored setting.

export const STORYBOARD_LIMITS = { keyframes: 24, segments: 24, props: 40, text: 4000, short: 200, comment: 4000 } as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const shortText = z.string().min(1).max(STORYBOARD_LIMITS.short);
/** Relative to the channel's `99 Data Exchange/`: `Sent to YTM/...`, or a job's output `From YTM/<gemini|media>/<jobId>/...`
 * (DEV-RESP-0029). Checked and hashed by the services, which name the keyframe in a refusal. */
const exchangeFile = z.string().min(1).max(500);

export const keyframeInputSchema = z
  .object({ id, file: exchangeFile, caption: z.string().max(STORYBOARD_LIMITS.short).nullable().optional(), parentKeyframeId: id.nullable().optional() })
  .strict();

export const segmentInputSchema = z
  .object({
    id,
    fromKeyframeId: id,
    toKeyframeId: id,
    action: z.string().min(1).max(STORYBOARD_LIMITS.text),
    durationSeconds: z.number().positive().max(600),
    model: z.string().max(STORYBOARD_LIMITS.short).nullable().optional(),
    settings: z.record(z.string().max(60), z.union([z.string().max(STORYBOARD_LIMITS.short), z.number(), z.boolean()])).optional(),
    estimateUsd: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict();

export const propInputSchema = z
  .object({ id, name: shortText, kind: z.enum(["object", "character"]), cells: z.record(id, z.string().max(STORYBOARD_LIMITS.short)) })
  .strict();

export const storyboardContentSchema = z
  .object({
    title: shortText,
    loop: z.boolean(),
    keyframes: z.array(keyframeInputSchema).min(2).max(STORYBOARD_LIMITS.keyframes),
    segments: z.array(segmentInputSchema).min(1).max(STORYBOARD_LIMITS.segments),
    props: z.array(propInputSchema).max(STORYBOARD_LIMITS.props).default([]),
    notes: z.string().max(STORYBOARD_LIMITS.text).nullable().optional(),
  })
  .strict();
export type StoryboardContentInput = z.infer<typeof storyboardContentSchema>;

export const createStoryboardInputSchema = storyboardContentSchema.extend({ channelId: z.string().min(1), storyboardId: id.optional(), planId: z.string().max(80).nullable().optional() }).strict();
export const updateStoryboardInputSchema = storyboardContentSchema.extend({ channelId: z.string().min(1), storyboardId: id }).strict();
export const storyboardRefSchema = z.object({ channelId: z.string().min(1), storyboardId: id }).strict();
export const listStoryboardsInputSchema = z
  .object({ channelId: z.string().min(1), state: z.enum(["draft", "in_review", "changes_requested", "approved"]).optional() })
  .strict();
export const operatorReplyInputSchema = z
  .object({ channelId: z.string().min(1), storyboardId: id, commentId: id, text: z.string().min(1).max(STORYBOARD_LIMITS.comment).optional(), resolve: z.boolean().optional() })
  .strict()
  .refine((input) => input.text !== undefined || input.resolve !== undefined, { message: "text or resolve is required" });

const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), r: z.number().min(0).max(1) }).strict();
export const commentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("storyboard") }).strict(),
  z.object({ kind: z.literal("keyframe"), keyframeId: id, region: region.nullable().optional() }).strict(),
  z.object({ kind: z.literal("segment"), segmentId: id }).strict(),
  z.object({ kind: z.literal("prop"), propId: id, keyframeId: id }).strict(),
]);
/** `versionNumber` is the version on the owner's screen: a comment is made on the latest version only. */
export const ownerCommentInputSchema = z
  .object({ versionNumber: z.number().int().min(1), target: commentTargetSchema, text: z.string().min(1).max(STORYBOARD_LIMITS.comment) })
  .strict();
export const ownerReplyInputSchema = z.object({ commentId: id, text: z.string().min(1).max(STORYBOARD_LIMITS.comment) }).strict();
export const ownerCommentStateInputSchema = z.object({ commentId: id, state: z.enum(["open", "resolved"]) }).strict();
export const ownerDecisionInputSchema = z
  .object({ kind: z.enum(["approved", "changes_requested"]), versionNumber: z.number().int().min(1), note: z.string().max(STORYBOARD_LIMITS.comment).nullable().optional() })
  .strict();
/** BL-184 stage 3 (B5): the owner's take for a segment of a version (null clears it). */
export const ownerPickInputSchema = z
  .object({
    versionNumber: z.number().int().min(1),
    segmentId: id,
    take: z.object({ source: z.enum(["media", "gemini"]), jobId: z.string().min(1).max(80) }).strict().nullable(),
  })
  .strict();

/** BL-184 stage 2 (B4): the owner's per-channel setting. */
export const gateSettingInputSchema = z.object({ requireApproved: z.boolean() }).strict();
