import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-143 phase 2 (docs/roadmap/plans/GENERATION_PLANS_PHASE_2_PLAN.md): every device publishes a report of ITS generation plans
// (read-only for the others) and of the verdicts it gave on other devices' plans. Per-device reports (`../per-device-report`):
// each device writes only its own; nothing is merged.

export const GLOBAL_DOCUMENT_KEY = "global";
export const GENERATION_PLANS_REPORT_FORMAT = "ytm-generation-plans";

/** A path relative to a workspace exchange folder: `/`-separated, no empty, `.` or `..` segment, no `\\`, not absolute. */
const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.startsWith("/") && !v.includes("\\") && !/^[A-Za-z]:/.test(v) && !v.split("/").some((s) => s === "" || s === "." || s === ".."), "a relative path");

/** A job output as `media/<jobId>/<file name>` relative to the channel workspace's `From YTM` (never an absolute path). */
export const jobOutputPathSchema = z.string().regex(/^media\/[A-Za-z0-9_-]{1,64}\/[^/\\]{1,200}$/, "media/<jobId>/<file>").refine((v) => !v.split("/").some((s) => s === "." || s === ".."), "a relative path");

const isoSchema = z.string().max(40);
const looseRecord = z.record(z.string().max(64), z.unknown());

const sharedResultRowSchema = z
  .object({
    stageId: z.string().max(40),
    itemKey: z.string().max(120),
    attemptRef: z.string().max(120),
    result: z.enum(["done", "failed", "accepted", "rejected"]),
    reportedBy: z.string().max(16),
    note: z.string().max(2000).nullable(),
    rating: z.number().int().min(1).max(10).nullable(),
    reasons: z.array(z.string().max(60)).max(20),
    markers: z.array(z.object({ start: z.number(), end: z.number().nullable(), note: z.string().max(200).nullable() }).strict()).max(50),
    auditionFile: relativePathSchema.nullable(),
    checks: z.array(looseRecord).max(50),
    metrics: looseRecord,
    referenceIds: z.array(z.string().max(64)).max(5).default([]),
    at: isoSchema,
  })
  .strict();

/** BL-157 (report version 2, SERVERS_MEDIA_PLAN.md AC-TC-05): one owner verdict of an attempt, as the history shows it. */
export const sharedVerdictHistorySchema = z
  .object({
    result: z.enum(["accepted", "rejected"]),
    rating: z.number().int().min(1).max(10).nullable(),
    note: z.string().max(2000).nullable(),
    /** The computer the verdict was given on (its host name, or its device id when it has none). */
    device: z.string().max(255),
    at: isoSchema,
  })
  .strict();

const paramValueSchema = z.union([z.string().max(500), z.number(), z.boolean()]);

/** BL-157 (report version 2, AC-WV-03): what the owning device knows about one wave (group) for the review's context card. */
export const sharedBatchSchema = z
  .object({
    groupId: z.string().max(40),
    title: z.string().max(200),
    /** The factory's context for the wave (`groups[].note`). */
    note: z.string().max(2000).nullable(),
    /** The owner's own note on the wave. */
    ownerNote: z.string().max(2000).nullable(),
    /** The earliest attempt of the wave. */
    firstAt: isoSchema.nullable(),
    templates: z.array(z.string().max(200)).max(20),
    /** The item params whose values differ between the wave's items, each with its distinct values. */
    differingParams: z.array(z.object({ name: z.string().max(64), values: z.array(paramValueSchema).max(20) }).strict()).max(60),
    /** The verdicts at the stage right before the owner's review, over the wave's attempts that have a row there. */
    validator: z.object({ passed: z.number().int().min(0), rejected: z.number().int().min(0) }).strict(),
  })
  .strict();

/**
 * BL-157 (report version 2, AC-TC-01/AC-WV-06): "being reviewed on this computer" -- a track (`attempt`) or a whole wave
 * (`group`) of a plan owned by `ownerDeviceId`. Advisory: it reaches the other computers within the sync delay.
 */
export const sharedClaimSchema = z
  .object({
    claimId: z.string().min(8).max(64),
    planId: z.string().max(80),
    ownerDeviceId: z.string().min(1).max(128),
    scope: z.enum(["attempt", "group"]),
    itemKey: z.string().max(120).nullable(),
    attemptRef: z.string().max(120).nullable(),
    groupId: z.string().max(40).nullable(),
    since: z.string().datetime({ offset: true }),
    until: z.string().datetime({ offset: true }),
  })
  .strict();

export const sharedReviewEntrySchema = z
  .object({
    itemKey: z.string().max(120),
    groupId: z.string().max(40).nullable(),
    attemptRef: z.string().max(120),
    jobId: z.string().max(64).nullable(),
    seed: z.number().nullable(),
    params: z.record(z.string().max(64), z.union([z.string().max(20_000), z.number(), z.boolean()])),
    stages: z.array(sharedResultRowSchema).max(20),
    verdict: sharedResultRowSchema.nullable(),
    playable: z.boolean(),
    /** The job's output to play, relative to the channel workspace's `From YTM`; null when the attempt has none. */
    jobOutput: jobOutputPathSchema.nullable(),
    /** BL-157 (v2, AC-RP-03): the channel the job ran on -- its output is in THAT channel's workspace; absent = the plan's. */
    jobChannelId: z.string().max(64).nullable().optional(),
    /** BL-157 (v2, AC-TC-05): the attempt's owner verdicts, oldest first (the last 10); absent in a version 1 report. */
    history: z.array(sharedVerdictHistorySchema).max(10).optional(),
  })
  .strict();

export const sharedPlanSchema = z
  .object({
    planId: z.string().max(80),
    title: z.string().max(200),
    channelId: z.string().max(64),
    owner: z.enum(["factory", "operator"]),
    status: z.enum(["active", "completed", "cancelled"]),
    budget: z.object({ usd: z.number().nullable(), gpuMinutes: z.number().nullable() }).strict(),
    note: z.string().max(2000).nullable(),
    createdAt: isoSchema,
    updatedAt: isoSchema,
    closedAt: isoSchema.nullable(),
    stages: z.array(z.object({ stageId: z.string().max(40), title: z.string().max(200), kind: z.enum(["in_app", "external", "owner_review"]) }).strict()).max(20),
    groups: z
      .array(
        z
          .object({
            groupId: z.string().max(40),
            title: z.string().max(200),
            dependsOn: z.string().max(40).nullable(),
            note: z.string().max(2000).nullable(),
            /** BL-157 (v2, AC-WV-04): the owner's note on the wave, apart from the factory's `note`. */
            ownerNote: z.string().max(2000).nullable().optional(),
          })
          .strict()
      )
      .max(200),
    /** Items without their job params (the progress is what other devices show). */
    items: z.array(z.object({ itemKey: z.string().max(120), groupId: z.string().max(40).nullable(), templateLabel: z.string().max(200).nullable(), targetCount: z.number(), mode: z.enum(["fixed", "until_accepted"]) }).strict()).max(1000),
    /** BL-143 phase 3: the plan's reference tracks for A/B (files relative to the channel's Sent to YTM). */
    references: z
      .array(z.object({ id: z.string().max(64), label: z.string().max(200), file: relativePathSchema, lufs: z.number().nullable(), lra: z.number().nullable(), truePeak: z.number().nullable() }).strict())
      .max(50)
      .default([]),
    /** The job params of the items that have review entries, once per item (the review screen's generation details). */
    itemParams: z.record(z.string().max(120), z.record(z.string().max(64), z.union([z.string().max(20_000), z.number(), z.boolean()]))).default({}),
    /** The plan's derived progress as the owning device computed it (shown, never recomputed elsewhere). */
    progress: looseRecord,
    events: z.array(z.object({ at: isoSchema, kind: z.string().max(40), actor: z.string().max(16), details: looseRecord }).strict()).max(50),
    review: z.array(sharedReviewEntrySchema).max(500),
    /** BL-157 (v2, AC-WV-03): the waves' context, computed on the owning device; absent in a version 1 report. */
    batches: z.array(sharedBatchSchema).max(200).optional(),
  })
  .strict();

/** A verdict this device gave on another device's plan, carried to that device in this device's report. */
export const sharedVerdictSchema = z
  .object({
    verdictId: z.string().min(8).max(64),
    planId: z.string().max(80),
    ownerDeviceId: z.string().min(1).max(128),
    itemKey: z.string().max(120),
    attemptRef: z.string().max(120),
    result: z.enum(["accepted", "rejected"]),
    rating: z.number().int().min(1).max(10).nullable(),
    reasons: z.array(z.string().max(60)).max(20),
    markers: z
      .array(z.object({ start: z.number().min(0).max(86_400), end: z.number().min(0).max(86_400).nullable(), note: z.string().max(200).nullable() }).strict().refine((m) => m.end === null || m.end >= m.start, "end >= start"))
      .max(50),
    note: z.string().max(2000).nullable(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md §B): the report version this build writes. It still reads version 1 (no job channel,
 * history, waves or claims). A version 1 build refuses a version 2 report (every level is strict), so both computers update.
 */
export const GENERATION_PLANS_REPORT_VERSION = 2;

export const generationPlansReportSchema = z
  .object({
    format: z.literal(GENERATION_PLANS_REPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2)]),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    plans: z.array(sharedPlanSchema).max(50),
    verdicts: z.array(sharedVerdictSchema).max(1000),
    /** BL-157 (v2, AC-TC-01): this device's live review claims, on any device's plans; absent in a version 1 report. */
    claims: z.array(sharedClaimSchema).max(200).optional(),
  })
  .strict();

export type SharedPlan = z.infer<typeof sharedPlanSchema>;
export type SharedReviewEntry = z.infer<typeof sharedReviewEntrySchema>;
export type SharedVerdict = z.infer<typeof sharedVerdictSchema>;
export type GenerationPlansReport = z.infer<typeof generationPlansReportSchema>;
export type SharedBatch = z.infer<typeof sharedBatchSchema>;
export type SharedClaim = z.infer<typeof sharedClaimSchema>;
export type SharedVerdictHistory = z.infer<typeof sharedVerdictHistorySchema>;
