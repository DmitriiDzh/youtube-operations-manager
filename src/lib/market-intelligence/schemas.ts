import { z } from "zod";
import { createdViaSchema } from "@/lib/shared-provenance";
export { parseWithSchema, formatZodError } from "./contracts";

// Same pattern as `src/lib/cli-auth/schemas.ts`'s `selectWriteChannelInputSchema` -- duplicated
// rather than shared, per this codebase's own `parseWithSchema` precedent (`AGENTS.md` §D: a
// tiny validation helper is kept independent per module rather than introducing a dependency for
// one regex). A canonical `UC...` id is required here (never a bare handle) -- resolving a
// `@handle`/URL to a channel id is deferred to a later slice (`docs/roadmap/plans/PHASE_9_PLAN.md`
// §8); `handleOrUrl` below is informational only.
const youtubeChannelIdSchema = z
  .string()
  .min(1, "channelId is required")
  .regex(/^UC[a-zA-Z0-9_-]{22}$/, "channelId must be a valid YouTube channel id");

export const addToWatchlistInputSchema = z
  .object({
    channelId: youtubeChannelIdSchema,
    handleOrUrl: z.string().min(1).max(500).optional(),
    reason: z.string().min(1, "reason is required").max(2000),
  })
  .strict();

export const listWatchlistOutputSchema = z
  .object({
    channels: z.array(
      z
        .object({
          channelId: z.string().min(1),
          handleOrUrl: z.string().nullable(),
          reason: z.string(),
          addedAt: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export const researchChannelSchema = z
  .object({
    channelId: z.string().min(1),
    handleOrUrl: z.string().nullable(),
    reason: z.string(),
    addedAt: z.string(),
  })
  .strict();

export const addToWatchlistOutputSchema = researchChannelSchema;

export const getWatchlistEntryInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const getWatchlistEntryOutputSchema = researchChannelSchema;

export const recordEvidenceInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    observation: z.string().min(1, "observation is required").max(2000),
    source: z.string().min(1, "source is required").max(500),
    confidence: z.string().min(1).max(200).optional(),
  })
  .strict();

export const researchEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    researchChannelId: z.string().min(1),
    observation: z.string(),
    source: z.string(),
    confidence: z.string().nullable(),
    collectedAt: z.string(),
  })
  .strict();

export const recordEvidenceOutputSchema = researchEvidenceSchema;

export const listEvidenceInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
  })
  .strict();

export const listEvidenceOutputSchema = z
  .object({
    evidence: z.array(researchEvidenceSchema),
  })
  .strict();

// Re-exported so services.ts/adapters never need their own separate import of the shared
// provenance vocabulary's schema (AGENTS.md §M: market-intelligence is a caller of
// shared-provenance, not a second owner of it).
export { createdViaSchema };

export type AddToWatchlistInput = z.infer<typeof addToWatchlistInputSchema>;
export type GetWatchlistEntryInput = z.infer<typeof getWatchlistEntryInputSchema>;
export type RecordEvidenceInput = z.infer<typeof recordEvidenceInputSchema>;
export type ListEvidenceInput = z.infer<typeof listEvidenceInputSchema>;
