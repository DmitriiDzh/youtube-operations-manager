import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { PLAN_ITEM_MODES, PLAN_RESULTS, PLAN_STAGE_KINDS, PLAN_STATUSES } from "./contracts";

export { parseWithSchema };

// BL-143 (GENERATION_PLANS_PLAN.md §1/§2): the shapes and bounds of plans, reports and verdicts.

export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const STAGE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ITEM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,119}$/;

export const PLAN_LIMITS = Object.freeze({
  stages: 20,
  groups: 200,
  items: 1000,
  seedsPerItem: 500,
  paramsPerItem: 60,
  reportRows: 200,
  checksPerRow: 50,
  metricsPerRow: 50,
  markersPerRow: 50,
  reasonsPerRow: 20,
  noteChars: 2000,
  detailChars: 200,
  importResults: 20_000,
  references: 50,
  referencesPerRow: 5,
});

export const planIdSchema = z.string().trim().regex(PLAN_ID_PATTERN, "a plan id: 2-80 letters, digits, '.', '_' or '-'");
const stageIdSchema = z.string().regex(STAGE_ID_PATTERN, "a stage id: lower-case letters, digits, '_' or '-'");
const groupIdSchema = z.string().regex(GROUP_ID_PATTERN, "a group id: up to 40 letters, digits, '.', '_' or '-'");
const itemKeySchema = z.string().regex(ITEM_KEY_PATTERN, "an item key: up to 120 letters, digits, '.', '_', '/', '+' or '-'");
const titleSchema = z.string().trim().min(1).max(200);
const noteSchema = z.string().max(PLAN_LIMITS.noteChars);
const paramValueSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean()]);
const seedSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const attemptRefSchema = z.string().min(1).max(120);

export const stageSchema = z.object({ stageId: stageIdSchema, title: titleSchema, kind: z.enum(PLAN_STAGE_KINDS) }).strict();
export const groupSchema = z
  .object({ groupId: groupIdSchema, title: titleSchema.optional(), dependsOn: groupIdSchema.nullable().optional(), note: noteSchema.nullable().optional() })
  .strict();
export const itemSchema = z
  .object({
    itemKey: itemKeySchema,
    groupId: groupIdSchema.nullable().optional(),
    templateLabel: z.string().max(200).nullable().optional(),
    templateId: z.string().min(1).max(64).nullable().optional(),
    variant: z.string().max(200).nullable().optional(),
    targetCount: z.number().int().min(1).max(10_000),
    mode: z.enum(PLAN_ITEM_MODES).optional(),
    maxAttempts: z.number().int().min(1).max(100_000).nullable().optional(),
    params: z.record(z.string().min(1).max(64), paramValueSchema).optional(),
    seeds: z.array(seedSchema).max(PLAN_LIMITS.seedsPerItem).optional(),
  })
  .strict();

export const referenceSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "a reference id: up to 64 letters, digits, '.', '_' or '-'"),
    label: z.string().trim().min(1).max(200),
    file: z
      .string()
      .min(1)
      .max(500)
      .refine((v) => !v.startsWith("/") && !v.includes("\\") && !/^[A-Za-z]:/.test(v) && !v.split("/").some((x) => x === "" || x === "." || x === ".."), "a path relative to the workspace's '99 Data Exchange/Sent to YTM/'"),
    lufs: z.number().min(-70).max(10).nullable().optional(),
    lra: z.number().min(0).max(100).nullable().optional(),
    truePeak: z.number().min(-70).max(20).nullable().optional(),
  })
  .strict();

const budgetSchema = z.object({ usd: z.number().min(0).max(100_000).nullable().optional(), gpuMinutes: z.number().min(0).max(1_000_000).nullable().optional() }).strict();

export const createPlanInputSchema = z
  .object({
    planId: planIdSchema,
    title: titleSchema,
    channelId: z.string().min(1).max(64),
    budget: budgetSchema.optional(),
    note: noteSchema.nullable().optional(),
    stages: z.array(stageSchema).min(1).max(PLAN_LIMITS.stages),
    groups: z.array(groupSchema).max(PLAN_LIMITS.groups).optional(),
    items: z.array(itemSchema).max(PLAN_LIMITS.items).optional(),
    references: z.array(referenceSchema).max(PLAN_LIMITS.references).optional(),
    /** BL-153: validator-rejected attempts that can be played also wait for the owner. */
    reviewRejected: z.boolean().optional(),
  })
  .strict();
export type CreatePlanInput = z.infer<typeof createPlanInputSchema>;

export const updatePlanInputSchema = z
  .object({
    planId: planIdSchema,
    title: titleSchema.optional(),
    note: noteSchema.nullable().optional(),
    budget: budgetSchema.optional(),
    /** Added at the end (a stage id already present is refused). */
    addStages: z.array(stageSchema).max(PLAN_LIMITS.stages).optional(),
    /** A group id already present replaces that group's title / dependsOn / note. */
    upsertGroups: z.array(groupSchema).max(PLAN_LIMITS.groups).optional(),
    /** An item key already present replaces the item (its results stay); a new one is added. */
    upsertItems: z.array(itemSchema).max(PLAN_LIMITS.items).optional(),
    removeStageIds: z.array(stageIdSchema).max(PLAN_LIMITS.stages).optional(),
    removeGroupIds: z.array(groupIdSchema).max(PLAN_LIMITS.groups).optional(),
    removeItemKeys: z.array(itemKeySchema).max(PLAN_LIMITS.items).optional(),
    /** An id already present replaces that reference. */
    upsertReferences: z.array(referenceSchema).max(PLAN_LIMITS.references).optional(),
    removeReferenceIds: z.array(z.string().min(1).max(64)).max(PLAN_LIMITS.references).optional(),
    /** BL-153: switches the review of validator-rejected attempts on or off. */
    reviewRejected: z.boolean().optional(),
  })
  .strict();
export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

export const closePlanInputSchema = z.object({ planId: planIdSchema, status: z.enum(["completed", "cancelled"]), note: noteSchema.nullable().optional() }).strict();

export const listPlansInputSchema = z.object({ status: z.enum(PLAN_STATUSES).optional(), channelId: z.string().min(1).max(64).optional() }).strict();

/** `latest`: the newest events instead of the oldest page from `since` (a reader that wants "what happened lately"). */
export const getPlanInputSchema = z.object({ planId: planIdSchema, since: z.string().datetime().optional(), latest: z.boolean().optional() }).strict();

const auditionFileSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.startsWith("/") && !v.includes("\\") && !/^[A-Za-z]:/.test(v) && !v.split("/").some((s) => s === "" || s === "." || s === ".."), "a path relative to the workspace's '99 Data Exchange/Sent to YTM/', with no '..' or '\\'");

const checkSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().max(100).nullable().optional(),
    value: z.union([z.number().finite(), z.string().max(200), z.boolean()]).nullable().optional(),
    unit: z.string().max(24).nullable().optional(),
    threshold: z.union([z.number().finite(), z.string().max(100)]).nullable().optional(),
    pass: z.boolean(),
    severity: z.enum(["info", "warn", "fail"]),
    atSeconds: z
      .tuple([z.number().min(0).max(86_400), z.number().min(0).max(86_400)])
      .refine(([a, b]) => a <= b, "start <= end")
      .nullable()
      .optional(),
    detail: z.string().max(PLAN_LIMITS.detailChars).nullable().optional(),
  })
  .strict();

const markerSchema = z
  .object({ start: z.number().min(0).max(86_400), end: z.number().min(0).max(86_400).nullable().optional(), note: z.string().max(200).nullable().optional() })
  .strict()
  .refine((m) => m.end === undefined || m.end === null || m.end >= m.start, "end >= start");

const verdictFieldsSchema = {
  rating: z.number().int().min(1).max(10).nullable().optional(),
  reasons: z.array(z.string().trim().min(1).max(60)).max(PLAN_LIMITS.reasonsPerRow).optional(),
  markers: z.array(markerSchema).max(PLAN_LIMITS.markersPerRow).optional(),
};

export const reportRowSchema = z
  .object({
    stageId: stageIdSchema,
    itemKey: itemKeySchema,
    attemptRef: attemptRefSchema,
    result: z.enum(PLAN_RESULTS),
    note: noteSchema.nullable().optional(),
    auditionFile: auditionFileSchema.nullable().optional(),
    checks: z.array(checkSchema).max(PLAN_LIMITS.checksPerRow).optional(),
    metrics: z
      .record(z.string().min(1).max(64), z.union([z.number().finite(), z.string().max(200), z.boolean()]).nullable())
      .refine((m) => Object.keys(m).length <= PLAN_LIMITS.metricsPerRow, `at most ${PLAN_LIMITS.metricsPerRow} metrics`)
      .optional(),
    ...verdictFieldsSchema,
    /** Plan references nearest to this attempt (FO-MSG-0009: the validator's nearest library tracks). */
    referenceIds: z.array(z.string().min(1).max(64)).max(PLAN_LIMITS.referencesPerRow).optional(),
  })
  .strict();
export type ReportRowInput = z.infer<typeof reportRowSchema>;

export const reportInputSchema = z.object({ planId: planIdSchema, rows: z.array(reportRowSchema).min(1).max(PLAN_LIMITS.reportRows) }).strict();

/** The owner's own verdict from the Web UI (always at the plan's owner-review stage). */
export const ownerVerdictInputSchema = z
  .object({
    planId: planIdSchema,
    itemKey: itemKeySchema,
    attemptRef: attemptRefSchema,
    result: z.enum(["accepted", "rejected"]),
    note: noteSchema.nullable().optional(),
    /** BL-157 (AC-TC-04): true = replace a verdict the attempt already has (the owner confirmed it). */
    replace: z.boolean().optional(),
    ...verdictFieldsSchema,
  })
  .strict();

/** BL-143 phase 2: the owner's verdict on ANOTHER device's plan (carried there in this device's report). */
export const peerVerdictInputSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    planId: planIdSchema,
    itemKey: itemKeySchema,
    attemptRef: attemptRefSchema,
    result: z.enum(["accepted", "rejected"]),
    note: noteSchema.nullable().optional(),
    /** BL-157 (AC-TC-04): true = replace a verdict the attempt already has (the owner confirmed it). */
    replace: z.boolean().optional(),
    ...verdictFieldsSchema,
  })
  .strict();

export const referenceInputSchema = z.object({ planId: planIdSchema, id: z.string().min(1).max(64) }).strict();

/**
 * BL-157 (AC-TC-01/AC-WV-06): this device claims (or, with `release`, gives up) a track or a wave of a plan for review.
 * `deviceId` = the device that owns the plan (absent = this device's own plan).
 */
export const reviewClaimInputSchema = z
  .object({
    deviceId: z.string().min(1).max(128).optional(),
    planId: planIdSchema,
    scope: z.enum(["attempt", "group"]),
    itemKey: itemKeySchema.optional(),
    attemptRef: attemptRefSchema.optional(),
    groupId: groupIdSchema.optional(),
    release: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.scope === "attempt" ? Boolean(v.itemKey && v.attemptRef) : Boolean(v.groupId)), "an attempt claim names itemKey and attemptRef; a group claim names groupId");

/** BL-157 (FO-REQ-0009 §4): an active plan moves to another connected channel; `checkOnly` only checks its files there. */
export const movePlanInputSchema = z.object({ planId: planIdSchema, channelId: z.string().min(1).max(64), checkOnly: z.boolean().optional() }).strict();

export const groupNoteInputSchema = z.object({ planId: planIdSchema, groupId: groupIdSchema, note: noteSchema.nullable() }).strict();

export const rerunRequestInputSchema = z.object({ planId: planIdSchema, itemKey: itemKeySchema, attemptRef: attemptRefSchema.optional(), note: noteSchema.nullable().optional() }).strict();

// -- running a stage (slice 2, AC-GP-09..12) -------------------------------------------------------------------------------

export const runStageInputSchema = z
  .object({ planId: planIdSchema, sessionId: z.string().min(1).max(64), itemKeys: z.array(itemKeySchema).min(1).max(PLAN_LIMITS.items).optional(), groupId: groupIdSchema.optional() })
  .strict()
  .refine((v) => !(v.itemKeys && v.groupId), "give itemKeys or groupId, not both");

export const rerunInputSchema = z.object({ planId: planIdSchema, sessionId: z.string().min(1).max(64), itemKey: itemKeySchema, seed: seedSchema.optional() }).strict();

export const cloneGroupInputSchema = z
  .object({
    planId: planIdSchema,
    groupId: groupIdSchema,
    newGroupId: groupIdSchema,
    title: titleSchema.optional(),
    paramsPatch: z.record(z.string().min(1).max(64), paramValueSchema).optional(),
    seeds: z.array(seedSchema).max(PLAN_LIMITS.seedsPerItem).optional(),
  })
  .strict();

/** A job created by hand (`factory_media_create_job`) that names a plan attempt. */
export const jobLinkInputSchema = z.object({ planId: planIdSchema, stageId: stageIdSchema.optional(), itemKey: itemKeySchema, seed: seedSchema.nullable().optional(), sessionId: z.string().min(1).max(64), channelId: z.string().min(1).max(64) }).strict();

// -- the `ytm-generation-plan/1` file (DEV-RESP-0008 §8, plus the factory's `group` field, FO-MSG-0008) ---------------------

export const importFileSchema = z
  .object({
    format: z.literal("ytm-generation-plan/1"),
    planId: planIdSchema,
    title: titleSchema,
    channelId: z.string().min(1).max(64),
    owner: z.enum(["factory", "operator"]).optional(),
    budget: budgetSchema.optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    note: noteSchema.nullable().optional(),
    stages: z.array(stageSchema).min(1).max(PLAN_LIMITS.stages),
    references: z.array(referenceSchema).max(PLAN_LIMITS.references).optional(),
    reviewRejected: z.boolean().optional(),
    /** FO-MSG-0010: the file's waves with their titles; `groupId` or `id`. Groups only named by items keep their id as title. */
    groups: z
      .array(
        z
          .object({
            groupId: groupIdSchema.optional(),
            id: groupIdSchema.optional(),
            title: titleSchema.optional(),
            dependsOn: groupIdSchema.nullable().optional(),
            note: noteSchema.nullable().optional(),
          })
          .passthrough()
      )
      .max(PLAN_LIMITS.groups)
      .optional(),
    items: z
      .array(
        z
          .object({
            itemKey: itemKeySchema,
            templateId: z.string().max(200).nullable().optional(),
            group: groupIdSchema.nullable().optional(),
            variant: z.string().max(200).nullable().optional(),
            targetCount: z.number().int().min(1).max(10_000),
            mode: z.enum(PLAN_ITEM_MODES).optional(),
            maxAttempts: z.number().int().min(1).max(100_000).nullable().optional(),
            params: z.record(z.string().min(1).max(64), paramValueSchema).optional(),
            seeds: z.array(seedSchema).max(PLAN_LIMITS.seedsPerItem).optional(),
          })
          .passthrough()
      )
      .max(PLAN_LIMITS.items),
    results: z
      .array(
        z
          .object({
            stageId: stageIdSchema,
            itemKey: itemKeySchema,
            attemptRef: attemptRefSchema,
            result: z.enum(PLAN_RESULTS),
            reportedBy: z.string().max(20).optional(),
            note: noteSchema.nullable().optional(),
            at: z.string().datetime({ offset: true }).optional(),
          })
          .passthrough()
      )
      .max(PLAN_LIMITS.importResults)
      .optional(),
  })
  .passthrough();
export type ImportFileInput = z.infer<typeof importFileSchema>;

export const importInputSchema = z.object({ plan: z.unknown() }).strict();
