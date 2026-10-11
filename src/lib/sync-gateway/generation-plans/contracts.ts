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

/** BL-175 (v5, VISUAL_REVIEW_PLAN.md §2.4): a pin on a picture, 0..1 (absent on a marker without one). */
const sharedRegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), r: z.number().gt(0).max(1) }).strict();
/** A marker as every level of the report carries it; `region` only from version 5. */
const sharedMarkerSchema = z.object({ start: z.number(), end: z.number().nullable(), note: z.string().max(200).nullable(), region: sharedRegionSchema.optional() }).strict();
/** BL-175 (v5): a plan's or a wave's own reason chips. */
const sharedReasonsSchema = z.array(z.string().max(60)).max(20);
/** BL-175 (v5): who picked an attempt, when, and the note given with it. */
const sharedPickMarkSchema = z.object({ device: z.string().max(255), at: isoSchema, note: z.string().max(2000).nullable() }).strict();

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
    markers: z.array(sharedMarkerSchema).max(50),
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
    /** BL-173 (v4): the re-check this answers; `kept` = the verdict was kept with a note (not a verdict). */
    recheckId: z.string().max(120).optional(),
    kept: z.boolean().optional(),
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
    /** BL-173 (v4): the file the attempt plays now when an accepted revision replaced its reported one. */
    currentFile: relativePathSchema.nullable().optional(),
    /** BL-175 (v5): the owner picked this attempt. */
    picked: sharedPickMarkSchema.optional(),
    /** BL-175 (v5): no verdict, not picked, but its item is decided -- not waiting. */
    notChosen: z.boolean().optional(),
  })
  .strict();

/**
 * BL-173 (v4, PLAN_RECHECKS_PLAN.md §2.7): an OPEN re-check of the owning device's plan -- what the other computer's review
 * screen shows -- with the extra row its entry shows (the revision's checks, or the accepted revision a question plays).
 */
export const sharedRecheckSchema = z
  .object({
    recheckId: z.string().max(120),
    itemKey: z.string().max(120),
    attemptRef: z.string().max(120),
    kind: z.enum(["revision", "question"]),
    title: z.string().max(60),
    note: z.string().max(1000),
    auditionFile: relativePathSchema.nullable(),
    markers: z.array(sharedMarkerSchema).max(50),
    checks: z.array(looseRecord).max(50),
    metrics: looseRecord,
    previousVerdict: z
      .object({
        result: z.enum(["accepted", "rejected"]),
        rating: z.number().int().min(1).max(10).nullable(),
        reasons: z.array(z.string().max(60)).max(20),
        markers: z.array(sharedMarkerSchema).max(50),
        note: z.string().max(2000).nullable(),
        device: z.string().max(255).nullable(),
        at: isoSchema,
      })
      .strict()
      .nullable(),
    openedAt: isoSchema,
    extraStage: sharedResultRowSchema.nullable(),
    /** A revision's "Before" when that is an earlier accepted revision (its row, for its loudness). */
    beforeStage: sharedResultRowSchema.nullable().optional(),
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
            /**
             * BL-162 (v3, FO-REQ-0013 §2.3): when the current owner note was written (on whichever computer), so a computer that
             * sent a note can tell whether it was applied (same time) or a newer one won; null = no owner note yet.
             */
            ownerNoteAt: z.string().datetime({ offset: true }).nullable().optional(),
            /** BL-175 (v5): the wave's own reason chips. */
            reviewReasons: sharedReasonsSchema.optional(),
          })
          .strict()
      )
      .max(200),
    /** Items without their job params (the progress is what other devices show). BL-175 (v5): `pickTarget` = `pickTargetOf`. */
    items: z
      .array(
        z
          .object({
            itemKey: z.string().max(120),
            groupId: z.string().max(40).nullable(),
            templateLabel: z.string().max(200).nullable(),
            targetCount: z.number(),
            mode: z.enum(["fixed", "until_accepted"]),
            pickTarget: z.number().int().min(1).optional(),
          })
          .strict()
      )
      .max(1000),
    /** BL-175 (v5): the plan's own reason chips. */
    reviewReasons: sharedReasonsSchema.optional(),
    /** BL-175 (v5): the plan's active picks and "none fits" (what the other computer's grid and counts show). */
    picks: z.array(z.object({ itemKey: z.string().max(120), attemptRef: z.string().max(120), device: z.string().max(255), at: isoSchema, note: z.string().max(2000).nullable() }).strict()).max(5000).optional(),
    noneFits: z.array(z.object({ itemKey: z.string().max(120), note: z.string().max(2000).nullable(), device: z.string().max(255), at: isoSchema, attempts: z.number().int().min(0) }).strict()).max(1000).optional(),
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
    /** BL-173 (v4): the plan's open re-checks; absent before version 4. */
    rechecks: z.array(sharedRecheckSchema).max(200).optional(),
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
      .array(
        z
          .object({ start: z.number().min(0).max(86_400), end: z.number().min(0).max(86_400).nullable(), note: z.string().max(200).nullable(), region: sharedRegionSchema.optional() })
          .strict()
          .refine((m) => m.end === null || m.end >= m.start, "end >= start")
      )
      .max(50),
    note: z.string().max(2000).nullable(),
    at: z.string().datetime({ offset: true }),
    /** BL-173 (v4): the re-check this verdict answers; `kept` = the verdict was kept with a note. */
    recheckId: z.string().max(120).optional(),
    kept: z.boolean().optional(),
  })
  .strict();

/** BL-162 (v3, FO-REQ-0013 §2.3): a wave note this device wrote on another device's plan, carried to that device in this device's report. */
export const sharedGroupNoteSchema = z
  .object({
    noteId: z.string().min(8).max(64),
    planId: z.string().max(80),
    ownerDeviceId: z.string().min(1).max(128),
    groupId: z.string().max(40),
    /** null = the note is cleared. */
    note: z.string().max(2000).nullable(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();

/** BL-175 (v5, VISUAL_REVIEW_PLAN.md §2.6): a pick action this device took on another device's plan, carried to that device. */
export const sharedPickActionSchema = z
  .object({
    pickId: z.string().min(8).max(64),
    planId: z.string().max(80),
    ownerDeviceId: z.string().min(1).max(128),
    itemKey: z.string().max(120),
    attemptRef: z.string().max(120).nullable(),
    action: z.enum(["pick", "unpick", "none_fits", "clear_none_fits"]),
    note: z.string().max(2000).nullable(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md §B): the report version this build writes. It still reads version 1 (no job channel,
 * history, waves or claims). A version 1 build refuses a version 2 report (every level is strict), so both computers update.
 * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2): version 3 adds the wave notes sent to other devices (`groupNotes`) and each wave's
 * `ownerNoteAt`. Read: 1-3. A version 2 build refuses a version 3 report ("update the app"), so both computers update again.
 * BL-173 (PLAN_RECHECKS_PLAN.md §2.7): version 4 adds the open re-checks (`plans[].rechecks`), an entry's `currentFile`, and
 * `recheckId` / `kept` on history entries and verdicts. Read: 1-4; a version 3 build refuses it, so both computers update again.
 * BL-175 (VISUAL_REVIEW_PLAN.md §2.6): version 5 adds marker `region`s, `reviewReasons` (plan, waves), items' `pickTarget`, the
 * plans' active `picks` / `noneFits`, entries' `picked` / `notChosen`, and the pick actions sent to other devices (`picks`).
 * Read: 1-5; a version 4 build refuses it, so both computers update again.
 */
export const GENERATION_PLANS_REPORT_VERSION = 5;

export const generationPlansReportSchema = z
  .object({
    format: z.literal(GENERATION_PLANS_REPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    plans: z.array(sharedPlanSchema).max(50),
    verdicts: z.array(sharedVerdictSchema).max(1000),
    /** BL-157 (v2, AC-TC-01): this device's live review claims, on any device's plans; absent in a version 1 report. */
    claims: z.array(sharedClaimSchema).max(200).optional(),
    /** BL-162 (v3): the newest wave note per plan and wave this device wrote on other devices' plans; absent before version 3. */
    groupNotes: z.array(sharedGroupNoteSchema).max(200).optional(),
    /** BL-175 (v5): the pick actions this device took on other devices' plans (30 days); absent before version 5. */
    picks: z.array(sharedPickActionSchema).max(1000).optional(),
  })
  .strict();

export type SharedPlan = z.infer<typeof sharedPlanSchema>;
export type SharedGroupNote = z.infer<typeof sharedGroupNoteSchema>;
export type SharedReviewEntry = z.infer<typeof sharedReviewEntrySchema>;
export type SharedVerdict = z.infer<typeof sharedVerdictSchema>;
export type GenerationPlansReport = z.infer<typeof generationPlansReportSchema>;
export type SharedBatch = z.infer<typeof sharedBatchSchema>;
export type SharedClaim = z.infer<typeof sharedClaimSchema>;
export type SharedVerdictHistory = z.infer<typeof sharedVerdictHistorySchema>;
export type SharedRecheck = z.infer<typeof sharedRecheckSchema>;
export type SharedPickAction = z.infer<typeof sharedPickActionSchema>;
