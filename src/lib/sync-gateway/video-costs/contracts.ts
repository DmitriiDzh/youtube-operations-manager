import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { VIDEO_NUMBER_PATTERN } from "../video-reservations/contracts";

export { DomainError, isDomainError };

// BL-194 stage 3 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): every paid run of THIS computer (RunPod jobs with
// their share of the session's charge, RunPod sessions without jobs, Gemini jobs), as a per-device report (the ADR 0028 pattern):
// each computer writes only its own runs and keeps every peer's latest report, so a video's total is the same on every computer.
// No prompt, parameter, path, key or provider text is carried -- only what a cost line needs. The rules that turn the reports into
// totals belong to `src/lib/video-costs` (this family imports nothing from it).

export const GLOBAL_DOCUMENT_KEY = "global";
export const VIDEO_COSTS_REPORT_FORMAT = "ytm-video-costs";
export const VIDEO_COSTS_REPORT_VERSION = 1;
/** A bound, not a working limit: the reporting computer keeps a bounded window (`src/lib/video-costs` retention). */
export const VIDEO_COSTS_REPORT_MAX = 20_000;

const iso = z.string().datetime({ offset: true });
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const usd = z.number().finite().min(0).max(100_000);

export const COST_RUN_BASES = ["measured", "estimated", "pending", "usage", "price_table", "not_charged", "unknown_outcome", "estimate"] as const;

export const sharedCostRunSchema = z
  .object({
    /** `runpod:<jobId>`, `gemini:<jobId>` or `session:<sessionId>` (a RunPod session that ran no job). */
    runId: z.string().regex(/^(runpod|gemini|session):[A-Za-z0-9._:-]{1,128}$/),
    source: z.enum(["runpod", "gemini"]),
    kind: z.enum(["job", "session"]),
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** The video this run is counted for; null = «не привязано». */
    video: z.string().regex(VIDEO_NUMBER_PATTERN).nullable(),
    /** The template's name (RunPod) or the Gemini model. */
    label: z.string().max(200).nullable(),
    mediaKind: z.enum(["image", "video", "audio", "other"]).nullable(),
    storyboardId: id.nullable(),
    storyboardVersion: z.number().int().min(1).max(100_000).nullable(),
    segmentId: id.nullable(),
    planId: z.string().max(128).nullable(),
    status: z.enum(["done", "failed", "cancelled", "active"]),
    usd,
    /**
     * RunPod: `measured` / `estimated` share of the session's charge, `pending` while its session runs (usd 0 until it ends). Gemini:
     * its `cost_basis`, or `estimate` while it runs (usd = its estimate).
     */
    basis: z.enum(COST_RUN_BASES),
    /** RunPod: the part of the share that is pod start / idle time (null without an hourly price, or for Gemini). */
    overheadUsd: usd.nullable(),
    gpuSeconds: z.number().finite().min(0).max(10_000_000).nullable(),
    createdAt: iso,
    finishedAt: iso.nullable(),
  })
  .strict();

export const videoCostsReportSchema = z
  .object({
    format: z.literal(VIDEO_COSTS_REPORT_FORMAT),
    version: z.literal(VIDEO_COSTS_REPORT_VERSION),
    deviceId: z.string().min(1).max(128),
    hostName: z.string().max(255).nullable(),
    updatedAt: iso,
    runs: z.array(sharedCostRunSchema).max(VIDEO_COSTS_REPORT_MAX),
  })
  .strict();

export type SharedCostRun = z.infer<typeof sharedCostRunSchema>;
export type VideoCostsReport = z.infer<typeof videoCostsReportSchema>;
