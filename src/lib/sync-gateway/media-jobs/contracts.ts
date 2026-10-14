import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { sharedJobProgressSchema } from "../media-sessions/contracts";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-188 (owner, Telegram 2026-10-14, msgs 2801/2803/2806; SHARED_MEDIA_JOBS_PLAN.md §2.1/§3): every computer's media jobs --
// RunPod/ComfyUI and Gemini -- as a per-device report (ADR 0028 pattern), so every computer shows one shared list. Strict and
// narrow: ids, status, progress without `detail`, template or model, plan/storyboard links, cost, times and the outputs' paths
// relative to the channel workspace. Never a URL, token, key, prompt text or a provider's error text: a failure crosses as a
// code only. Defined here: sync-gateway imports nothing from media-generation or gemini-media.
// ---------------------------------------------------------------------------

export const GLOBAL_DOCUMENT_KEY = "global";
export const MEDIA_JOBS_REPORT_FORMAT = "ytm-media-jobs";
/**
 * Version 2 (BL-188 stage 2, SHARED_MEDIA_JOBS_PLAN.md §2.3): adds `commands` (actions this device's owner took on another
 * device's jobs or sessions) and `commandResults` (what this device did with the commands it received). Read: 1-2. A version 1
 * build refuses a version 2 report (every level is strict), so both computers update.
 */
/**
 * Version 3 (BL-188 stage 4, owner msg 2806 Q3): a `create_job` may be a Gemini job (`source: "gemini"` with the `gemini`
 * request: model, prompt, image or video settings, inputs) for the computer whose key and limits will run it. Read: 1-3. A
 * version 2 build refuses a version 3 report, so both computers update together (as for version 2).
 */
export const MEDIA_JOBS_REPORT_VERSION = 3;
/** Finished jobs older than this are left out of the report (owner msg 2806: 7 days); unfinished ones are always in. */
export const MEDIA_JOBS_FINISHED_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** At most this many jobs per device (newest first; unfinished ones are kept before finished ones). */
export const MEDIA_JOBS_REPORT_MAX = 1000;
export const MEDIA_JOB_OUTPUTS_MAX = 50;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const isoTime = z.string().max(40);
/** A job output, relative to the channel's `99 Data Exchange/` folder: `From YTM/<media|gemini>/<jobId>/<file…>`, `/` only. */
const outputPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.includes("\\") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), "a relative path with / separators");

export const sharedMediaJobSchema = z
  .object({
    jobId: id,
    /** Which module runs it: a RunPod/ComfyUI session's job, or a Gemini job. */
    source: z.enum(["runpod", "gemini"]),
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** The kind of media it makes (null: not known, e.g. a RunPod template with no kind and no output yet). */
    mediaKind: z.enum(["audio", "image", "video"]).nullable(),
    status: z.string().regex(/^[a-z_]{1,32}$/),
    createdBy: z.string().max(32),
    /** RunPod: the template's name and version; Gemini: the model. */
    label: z.string().max(160),
    sessionId: id.nullable(),
    progress: sharedJobProgressSchema.nullable(),
    plan: z.object({ planId: z.string().max(80), itemKey: z.string().max(200).nullable(), seed: z.number().int().nullable() }).strict().nullable(),
    storyboard: z.object({ storyboardId: z.string().max(80), versionNumber: z.number().int().min(0), segmentId: z.string().max(80) }).strict().nullable(),
    /** Gemini only: what the job cost (or its estimate while unfinished), in USD; null for RunPod (billed per session). */
    costUsd: z.number().min(0).max(100_000).nullable(),
    costIsEstimate: z.boolean(),
    /** A failure's code (our own, never the provider's text); null when it has none. */
    errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
    createdAt: isoTime,
    submittedAt: isoTime.nullable(),
    finishedAt: isoTime.nullable(),
    outputs: z.array(outputPath).max(MEDIA_JOB_OUTPUTS_MAX),
  })
  .strict();

/** The actions relayed to the computer that runs the job or owns the session (§2.3). */
export const MEDIA_JOB_COMMAND_KINDS = ["cancel_job", "create_job", "approve_session", "reject_session"] as const;
export type MediaJobCommandKind = (typeof MEDIA_JOB_COMMAND_KINDS)[number];
/** A `create_job` seen first later than this after it was issued is refused (`command_expired`): a stale "run" never spends. */
export const MEDIA_JOB_CREATE_COMMAND_MAX_AGE_MS = 15 * 60_000;
/** Outgoing commands stay in the report this long (the executor may be switched off for a while); at most this many. */
export const MEDIA_JOB_COMMANDS_KEEP_MS = 7 * 24 * 60 * 60_000;
export const MEDIA_JOB_COMMANDS_MAX = 500;
export const MEDIA_JOB_COMMAND_RESULTS_MAX = 1000;

const commandId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
/** A file named relative to the channel's `99 Data Exchange/Sent to YTM/` on the executing computer (its own copy). */
const sentPath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.includes("\\") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), "a relative path with / separators");

/**
 * BL-188 stage 4: the owner's Gemini request relayed to the computer that runs it. The shape only (bounded, no URL or key); the
 * executor's Gemini module checks the model, the settings, the inputs, the storyboard gate and its own limits like a local create.
 */
export const sharedGeminiCreateSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    model: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
    prompt: z.string().min(1).max(10_000),
    image: z
      .object({
        size: z.string().min(1).max(10),
        aspectRatio: z.string().min(1).max(10),
        inputs: z.object({ images: z.array(sentPath).max(14).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        resolution: z.string().min(1).max(10),
        aspectRatio: z.string().min(1).max(10),
        durationSeconds: z.number().int().min(1).max(60),
        personGeneration: z.enum(["allow_all", "allow_adult"]).optional(),
        inputs: z.object({ firstFrame: sentPath.optional(), lastFrame: sentPath.optional(), referenceImages: z.array(sentPath).max(3).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    storyboardId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    segmentId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  })
  .strict()
  .refine((g) => (g.kind === "image" ? g.image !== undefined && g.video === undefined : g.video !== undefined && g.image === undefined), "an image request takes `image`, a video request `video`");
const paramValue = z.union([z.string().max(20_000), z.number().finite(), z.boolean()]);

/**
 * One action this device's owner took on another device's job or session, carried to that device in this device's report. A
 * `create_job` carries the request the owner typed (template and parameters): the executor validates it like a local create.
 */
export const sharedJobCommandSchema = z
  .object({
    commandId,
    kind: z.enum(MEDIA_JOB_COMMAND_KINDS),
    targetDeviceId: z.string().min(1).max(128),
    /** cancel_job: which module's job; create_job: null or "runpod" (a run on a session) or "gemini" (version 3). */
    source: z.enum(["runpod", "gemini"]).nullable(),
    jobId: id.nullable(),
    sessionId: z.string().min(1).max(64).nullable(),
    /** The channel the job or session belongs to, as the issuing device saw it; the executor checks it again. */
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    create: z
      .object({
        templateId: z.string().min(1).max(128),
        params: z.record(z.string().max(128), paramValue).refine((p) => Object.keys(p).length <= 100, "at most 100 parameters"),
      })
      .strict()
      .nullable(),
    /** reject_session: the owner's reason. */
    reason: z.string().max(500).nullable(),
    /** Version 3: create_job with `source: "gemini"` -- the request the executor's Gemini module runs. */
    gemini: sharedGeminiCreateSchema.optional(),
    issuedAt: z.string().datetime(),
    /** The issuing computer's name, as the executor's audit shows it. */
    issuedOn: z.string().max(64).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    if (c.kind === "cancel_job") need(c.source !== null && c.jobId !== null, "cancel_job needs source and jobId");
    if (c.kind === "create_job") {
      if (c.source === "gemini") need(c.channelId !== null && c.gemini !== undefined && c.create === null && c.sessionId === null, "a Gemini create_job needs channelId and gemini (no session, no template)");
      else need(c.sessionId !== null && c.channelId !== null && c.create !== null && c.gemini === undefined, "create_job needs sessionId, channelId and create");
    }
    if (c.kind !== "create_job") need(c.gemini === undefined, "only a create_job carries a Gemini request");
    if (c.kind === "approve_session" || c.kind === "reject_session") need(c.sessionId !== null, `${c.kind} needs sessionId`);
  });

/** What the executing device did with a command it received (its own codes and texts only, never a provider's text). */
export const sharedCommandResultSchema = z
  .object({
    commandId,
    issuerDeviceId: z.string().min(1).max(128),
    kind: z.enum(MEDIA_JOB_COMMAND_KINDS),
    /** `applying`: taken, not finished yet (a create may upload inputs for a while). */
    status: z.enum(["applied", "refused", "applying"]),
    code: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),
    /** create_job: the job it made. */
    jobId: id.nullable(),
    at: z.string().datetime(),
  })
  .strict();

export const mediaJobsReportSchema = z
  .object({
    format: z.literal(MEDIA_JOBS_REPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    deviceId: z.string().min(1).max(128),
    /** The computer's own name, shown in the "Компьютер" column. */
    hostName: z.string().regex(/^[\p{L}\p{N} ._'-]{1,64}$/u).nullable(),
    updatedAt: z.string().datetime(),
    jobs: z.array(sharedMediaJobSchema).max(MEDIA_JOBS_REPORT_MAX),
    /** Version 2: this device's commands to other devices (absent in a version 1 report). */
    commands: z.array(sharedJobCommandSchema).max(MEDIA_JOB_COMMANDS_MAX).optional(),
    /** Version 2: the results of the commands this device received, newest first. */
    commandResults: z.array(sharedCommandResultSchema).max(MEDIA_JOB_COMMAND_RESULTS_MAX).optional(),
  })
  .strict();

export type SharedMediaJob = z.infer<typeof sharedMediaJobSchema>;
export type MediaJobsReport = z.infer<typeof mediaJobsReportSchema>;
export type SharedJobCommand = z.infer<typeof sharedJobCommandSchema>;
export type SharedCommandResult = z.infer<typeof sharedCommandResultSchema>;
export type SharedGeminiCreate = z.infer<typeof sharedGeminiCreateSchema>;
