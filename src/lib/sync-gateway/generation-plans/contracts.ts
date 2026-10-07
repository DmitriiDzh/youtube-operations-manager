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
    at: isoSchema,
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
    groups: z.array(z.object({ groupId: z.string().max(40), title: z.string().max(200), dependsOn: z.string().max(40).nullable(), note: z.string().max(2000).nullable() }).strict()).max(200),
    /** Items without their job params (the progress is what other devices show). */
    items: z.array(z.object({ itemKey: z.string().max(120), groupId: z.string().max(40).nullable(), templateLabel: z.string().max(200).nullable(), targetCount: z.number(), mode: z.enum(["fixed", "until_accepted"]) }).strict()).max(1000),
    /** The job params of the items that have review entries, once per item (the review screen's generation details). */
    itemParams: z.record(z.string().max(120), z.record(z.string().max(64), z.union([z.string().max(20_000), z.number(), z.boolean()]))).default({}),
    /** The plan's derived progress as the owning device computed it (shown, never recomputed elsewhere). */
    progress: looseRecord,
    events: z.array(z.object({ at: isoSchema, kind: z.string().max(40), actor: z.string().max(16), details: looseRecord }).strict()).max(50),
    review: z.array(sharedReviewEntrySchema).max(500),
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

export const generationPlansReportSchema = z
  .object({
    format: z.literal(GENERATION_PLANS_REPORT_FORMAT),
    version: z.literal(1),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    plans: z.array(sharedPlanSchema).max(50),
    verdicts: z.array(sharedVerdictSchema).max(1000),
  })
  .strict();

export type SharedPlan = z.infer<typeof sharedPlanSchema>;
export type SharedReviewEntry = z.infer<typeof sharedReviewEntrySchema>;
export type SharedVerdict = z.infer<typeof sharedVerdictSchema>;
export type GenerationPlansReport = z.infer<typeof generationPlansReportSchema>;
