import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-236 (owner, Telegram 2026-10-29, msg 3823: limits and spend shared by every computer, "как у других API"; ADR 0057 as ADR 0039):
// every computer publishes the ElevenLabs characters it used today and this month (and their list-price USD), so computers on the
// SAME ElevenLabs key add them up and hold one daily and monthly character limit. A per-device report (`../per-device-report`): each
// device writes only its own. The key is named only by a fingerprint (an HMAC computed by elevenlabs-speech), never the key or its
// last characters. Never in a report: texts, voices, ElevenLabs' error text.

export const GLOBAL_DOCUMENT_KEY = "global";
export const ELEVENLABS_SPEND_REPORT_FORMAT = "ytm-elevenlabs-spend";
export const ELEVENLABS_SPEND_REPORT_VERSION = 1;

export const elevenlabsSpendReportSchema = z
  .object({
    format: z.literal(ELEVENLABS_SPEND_REPORT_FORMAT),
    version: z.literal(1),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    /** 32 lowercase hex characters, or null when no usable key is stored on that computer. */
    keyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    /** That computer's local day and month: finished jobs' charged characters plus active jobs' characters. Bounded (one bad report
     * must not be able to claim an absurd use: it counts against every same-key computer's limits). */
    usedTodayChars: z.number().int().min(0).max(100_000_000),
    usedMonthChars: z.number().int().min(0).max(1_000_000_000),
    /** The same at the list price (an estimate; the subscription pays). */
    spentTodayUsd: z.number().min(0).max(100_000),
    spentMonthUsd: z.number().min(0).max(1_000_000),
  })
  .strict();

export type ElevenlabsSpendReport = z.infer<typeof elevenlabsSpendReportSchema>;
