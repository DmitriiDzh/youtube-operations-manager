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
export const MEDIA_JOBS_REPORT_VERSION = 1;
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

export const mediaJobsReportSchema = z
  .object({
    format: z.literal(MEDIA_JOBS_REPORT_FORMAT),
    version: z.literal(MEDIA_JOBS_REPORT_VERSION),
    deviceId: z.string().min(1).max(128),
    /** The computer's own name, shown in the "Компьютер" column. */
    hostName: z.string().regex(/^[\p{L}\p{N} ._'-]{1,64}$/u).nullable(),
    updatedAt: z.string().datetime(),
    jobs: z.array(sharedMediaJobSchema).max(MEDIA_JOBS_REPORT_MAX),
  })
  .strict();

export type SharedMediaJob = z.infer<typeof sharedMediaJobSchema>;
export type MediaJobsReport = z.infer<typeof mediaJobsReportSchema>;
