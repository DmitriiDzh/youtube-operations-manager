import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-138 (owner, Telegram 2026-10-06, msgs 1706/1735/1739; plan docs/roadmap/plans/MEDIA_SESSIONS_CROSS_DEVICE_PLAN.md,
// ADR 0028): every device publishes a report of its RunPod generation sessions so the other devices can show them. Unlike the
// Automerge families, nothing is merged: each device writes only its OWN report (its own `<deviceId>` file in the family's
// Syncthing subfolder, the shared per-device transport) and keeps the latest report of every peer. No conflicts by construction.

/** The one constant key this family is synced under (one report per device, no per-channel documents). */
export const GLOBAL_DOCUMENT_KEY = "global";
export const MEDIA_SESSIONS_REPORT_FORMAT = "ytm-media-sessions";

/** What another device may see of a session: its state and cost, never a URL, token or error text from RunPod. */
export const sharedSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    channelId: z.string().min(1).max(64),
    status: z.string().min(1).max(32),
    requestedBy: z.string().min(1).max(32),
    gpuTypeId: z.string().max(128).nullable(),
    datacenterId: z.string().max(32).nullable(),
    podId: z.string().max(64).nullable(),
    costPerHr: z.number().nullable(),
    maxMinutes: z.number(),
    maxUsd: z.number().nullable(),
    createdAt: z.string().max(40),
    approvedAt: z.string().max(40).nullable(),
    startedAt: z.string().max(40).nullable(),
    stoppedAt: z.string().max(40).nullable(),
    secondsUsed: z.number().nullable(),
    usdCharged: z.number().nullable(),
    stopReason: z.string().max(200).nullable(),
  })
  .strict();

export const mediaSessionsReportSchema = z
  .object({
    format: z.literal(MEDIA_SESSIONS_REPORT_FORMAT),
    version: z.literal(1),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    /** The RunPod account id (GraphQL `myself.id`), or null when it could not be read; never anything derived from a key. */
    runpodAccountId: z.string().max(128).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    /** Bounded: one bad report must not be able to claim an absurd spend (it counts against this device's daily cap). */
    spentTodayUsd: z.number().min(0).max(100_000),
    sessions: z.array(sharedSessionSchema).max(200),
  })
  .strict();

export type SharedMediaSession = z.infer<typeof sharedSessionSchema>;
export type MediaSessionsReport = z.infer<typeof mediaSessionsReportSchema>;
