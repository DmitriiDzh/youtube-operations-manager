import { z } from "zod";
import { parseWithSchema } from "@/lib/changesets/schemas";

export { parseWithSchema };

// Bounded-length, purely structural -- this repository never validates or supplies
// the CONTENT of editorial context (AGENTS.md §B); the length cap only prevents an
// oversized request body, mirroring the discipline already applied to other free-text
// fields (see YOUTUBE_TITLE_MAX_LENGTH/YOUTUBE_DESCRIPTION_MAX_LENGTH elsewhere).
const MAX_EDITORIAL_BRIEF_FIELD_LENGTH = 2000;
const editorialBriefFieldSchema = z.string().min(1).max(MAX_EDITORIAL_BRIEF_FIELD_LENGTH).optional();

export const generationContextSchema = z
  .object({
    targetAudience: editorialBriefFieldSchema,
    toneNotes: editorialBriefFieldSchema,
    terminologyNotes: editorialBriefFieldSchema,
    titleConstraints: editorialBriefFieldSchema,
    descriptionConstraints: editorialBriefFieldSchema,
  })
  .strict();

export const generateProposalsInputSchema = z
  .object({
    channelId: z.string().min(1),
    videoIds: z.array(z.string().min(1)).min(1).max(200),
    targetLanguages: z.array(z.string().min(1)).min(1).max(50),
    providerName: z.string().min(1).optional(),
    // Phase 6, AI Connections: selecting a saved, user-configured connection instead
    // of the static mock-only `providerName` path. Mutually additive with
    // `providerName` -- if both are omitted, the default mock provider is used
    // exactly as before this feature existed (backward compatible).
    connectionId: z.string().min(1).optional(),
    editorialBrief: generationContextSchema.optional(),
  })
  .strict();

export const reviewedProposalSchema = z
  .object({
    videoId: z.string().min(1),
    language: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

// Provenance is an echo of exactly what a prior `generateProposals` response returned
// (see contracts.ts's `GenerationProvenance`) -- this repository does not re-derive or
// verify it against the live profile at persistence time (the whole point is to record
// what was actually used, which may since have changed). It is optional: a client that
// doesn't echo it back simply gets no provenance row (never a hard failure).
export const generationProvenanceSchema = z
  .object({
    profileVersion: z.number().int().nullable(),
    effectiveContext: generationContextSchema.nullable(),
  })
  .strict();

export const createChangeSetFromGenerationInputSchema = z
  .object({
    channelId: z.string().min(1),
    proposals: z.array(reviewedProposalSchema).min(1).max(10_000),
    provenance: generationProvenanceSchema.optional(),
  })
  .strict();

// Every field optional AND nullable: omitted = "leave this field unchanged" (a partial
// edit), explicit `null` = "clear this field". Distinct from generationContextSchema's
// fields, which are only ever a per-call override (no persisted "clear" concept there).
const editableProfileFieldSchema = z.string().min(1).max(MAX_EDITORIAL_BRIEF_FIELD_LENGTH).nullable().optional();

export const getEditorialProfileInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const getGenerationProvenanceInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
  })
  .strict();

export const saveEditorialProfileInputSchema = z
  .object({
    channelId: z.string().min(1),
    targetAudience: editableProfileFieldSchema,
    toneNotes: editableProfileFieldSchema,
    terminologyNotes: editableProfileFieldSchema,
    titleConstraints: editableProfileFieldSchema,
    descriptionConstraints: editableProfileFieldSchema,
  })
  .strict();

export type GenerateProposalsInput = z.infer<typeof generateProposalsInputSchema>;
export type CreateChangeSetFromGenerationInput = z.infer<typeof createChangeSetFromGenerationInputSchema>;
export type GetEditorialProfileInput = z.infer<typeof getEditorialProfileInputSchema>;
export type SaveEditorialProfileInput = z.infer<typeof saveEditorialProfileInputSchema>;
