import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.11, ADR 0036 §9): the per-device report of this computer's live streams
// (ADR 0028 pattern). The Mac publishes; every other computer shows the streams read-only. Strict and narrow on purpose:
// states and causes are fixed codes, YouTube's words are plain words, a video is its id -- no field can hold a key, a URL, an
// ingestion address or error text (§4.1 "Report"). Defined here: sync-gateway imports nothing from live-streams.
// ---------------------------------------------------------------------------

export const GLOBAL_DOCUMENT_KEY = "global";
export const LIVE_STREAMS_REPORT_FORMAT = "ytm-live-streams";
export const LIVE_STREAMS_REPORT_VERSION = 1;

const word = z.string().regex(/^[A-Za-z]{1,30}$/);

export const sharedLiveStreamSchema = z
  .object({
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    state: z.enum(["off", "ended_by_youtube", "starting", "live", "replaying", "no_source", "reconnecting"]),
    since: z.string().datetime().nullable(),
    playing: z
      .object({ index: z.number().int().min(0).max(10_000), total: z.number().int().min(0).max(10_000), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) })
      .strict()
      .nullable(),
    health: z
      .object({ lifeCycleStatus: word.nullable(), streamStatus: word.nullable(), healthStatus: word.nullable(), issueTypes: z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).max(20) })
      .strict()
      .nullable(),
    lastInterruption: z.object({ at: z.string().datetime(), cause: z.string().regex(/^[a-z_]{1,40}$/) }).strict().nullable(),
    viewers: z.number().int().min(0).max(100_000_000).nullable(),
  })
  .strict();

export const liveStreamsReportSchema = z
  .object({
    format: z.literal(LIVE_STREAMS_REPORT_FORMAT),
    version: z.literal(LIVE_STREAMS_REPORT_VERSION),
    deviceId: z.string().min(1).max(128),
    /** The computer's own name, shown as "on <host>"; plain letters, digits, spaces, '.', '-', '_'. */
    hostName: z.string().regex(/^[\p{L}\p{N} ._'-]{1,64}$/u).nullable(),
    updatedAt: z.string().datetime(),
    streams: z.array(sharedLiveStreamSchema).max(50),
  })
  .strict();

export type SharedLiveStream = z.infer<typeof sharedLiveStreamSchema>;
export type LiveStreamsReport = z.infer<typeof liveStreamsReportSchema>;
