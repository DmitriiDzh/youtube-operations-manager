import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867; ADR 0039): every computer publishes what it spent through Google's Gemini
// API today and this month, so computers that use the SAME Gemini key can add their spend up and hold one shared limit. A
// per-device report (`../per-device-report`, like `media-sessions`): each device writes only its own; nothing is merged.
//
// The key itself never leaves the computer: the report names it only by a fingerprint (`keyFingerprint`, an HMAC of the key
// computed by gemini-media, ADR 0039), never the key, its last characters or a plain hash of it. Never in a report: prompts,
// inputs, Google's error text.

/** The one constant key this family is synced under (one report per device). */
export const GLOBAL_DOCUMENT_KEY = "global";
export const GEMINI_SPEND_REPORT_FORMAT = "ytm-gemini-spend";
export const GEMINI_SPEND_REPORT_VERSION = 1;

export const geminiSpendReportSchema = z
  .object({
    format: z.literal(GEMINI_SPEND_REPORT_FORMAT),
    version: z.literal(1),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    /** 32 lowercase hex characters (128 bits of HMAC-SHA256), or null when no usable key is stored on that computer. */
    keyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    /** That computer's local day and month, finished jobs' cost plus active jobs' estimate (what its own limits count). Bounded: one
     * bad report must not be able to claim an absurd spend (it counts against every same-key computer's limits). */
    spentTodayUsd: z.number().min(0).max(100_000),
    spentMonthUsd: z.number().min(0).max(1_000_000),
  })
  .strict();

export type GeminiSpendReport = z.infer<typeof geminiSpendReportSchema>;
