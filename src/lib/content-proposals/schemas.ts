import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { CREATED_VIA_VALUES, MAX_EVIDENCE_LIST_ITEMS, evidenceReferenceSchema } from "@/lib/shared-provenance";
import { creativeAssetSchema, registerAssetInputSchema } from "@/lib/asset-catalog/schemas";

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: z.ZodType<T>, payload: unknown, context: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: `Invalid ${context}`,
      details: formatZodError(parsed.error),
    });
  }

  return parsed.data;
}

// Bounded-length only, never a validation of the CONTENT (AGENTS.md §B) -- same discipline as
// every other free-text field in this codebase (generationContextSchema, evidenceReferenceSchema).
const MAX_FREE_TEXT_LENGTH = 4000;
const MAX_BRIEF_FIELD_LENGTH = 2000;
const MAX_BRIEF_LIST_ITEMS = 20;
const MAX_BRIEF_LIST_ITEM_LENGTH = 200;
const MAX_REFERENCE_IDS = 50;

const briefTextField = z.string().min(1).max(MAX_BRIEF_FIELD_LENGTH).nullable().optional();
const briefListField = z.array(z.string().min(1).max(MAX_BRIEF_LIST_ITEM_LENGTH)).max(MAX_BRIEF_LIST_ITEMS).nullable().optional();

export const contentProposalBriefSchema = z
  .object({
    proposedTitleDirection: briefTextField,
    thumbnailDirection: briefTextField,
    visualBrief: briefTextField,
    audioBrief: briefTextField,
    durationHint: briefTextField,
    publicationHypothesis: briefTextField,
    localizationStrategy: briefTextField,
    experimentDesign: briefTextField,
    expectedMetrics: briefListField,
    requiredProductionOutputs: briefListField,
  })
  .strict();

// No `credentialRef` -- mirrors `asset-catalog`/`agent-operations` slice B's convention: there is
// no external API call here to defer validation to, so the caller (MCP/CLI) resolves the active-
// user identity and calls `channelAccessCore.assertActiveChannel` itself before invoking any
// function below.
export const createContentProposalInputSchema = z
  .object({
    channelId: z.string().min(1),
    objective: z.string().min(1).max(MAX_FREE_TEXT_LENGTH).optional(),
    topicConcept: z.string().min(1).max(MAX_FREE_TEXT_LENGTH).optional(),
    rationale: z.string().min(1).max(MAX_FREE_TEXT_LENGTH).optional(),
    evidence: z.array(evidenceReferenceSchema).max(MAX_EVIDENCE_LIST_ITEMS).optional(),
    brief: contentProposalBriefSchema.optional(),
    referenceVideoIds: z.array(z.string().min(1)).max(MAX_REFERENCE_IDS).optional(),
    referenceAssetIds: z.array(z.string().min(1)).max(MAX_REFERENCE_IDS).optional(),
  })
  .strict();

export const getContentProposalInputSchema = z
  .object({
    channelId: z.string().min(1),
    proposalId: z.string().min(1),
  })
  .strict();

export const listContentProposalsInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

const contentProposalSchema = z
  .object({
    proposalId: z.string().min(1),
    channelId: z.string().min(1),
    objective: z.string().nullable(),
    topicConcept: z.string().nullable(),
    rationale: z.string().nullable(),
    evidence: z.array(evidenceReferenceSchema).nullable(),
    brief: contentProposalBriefSchema.nullable(),
    referenceVideoIds: z.array(z.string()).nullable(),
    referenceAssetIds: z.array(z.string()).nullable(),
    createdAt: z.string(),
    createdVia: z.enum(CREATED_VIA_VALUES),
    agentApiVersion: z.string().nullable(),
  })
  .strict();

export const createContentProposalOutputSchema = contentProposalSchema;
export const getContentProposalOutputSchema = contentProposalSchema;
export const listContentProposalsOutputSchema = z.object({ proposals: z.array(contentProposalSchema) }).strict();

// Owner spec §19/§17: agent-callable artifact registration is deliberately restricted to
// `"url"`/`"external_artifact_id"` -- NOT the full `ASSET_REFERENCE_KINDS` (which also includes
// `"local_path"`, kept operator-only via the pre-existing `asset register` CLI command). Derived
// from asset-catalog's own `registerAssetInputSchema` (`.omit`/`.extend`, never a hand-copied
// second definition of `assetType`/`referenceValue`/etc. -- the RISK-53 duplication pattern) with
// only `referenceKind` narrowed and `proposalId` added.
export const AGENT_ARTIFACT_REFERENCE_KINDS = ["url", "external_artifact_id"] as const;
const agentArtifactReferenceKindSchema = z.enum(AGENT_ARTIFACT_REFERENCE_KINDS);

export const registerExternalArtifactInputSchema = registerAssetInputSchema
  .omit({ referenceKind: true })
  .extend({
    proposalId: z.string().min(1),
    referenceKind: agentArtifactReferenceKindSchema,
  });

export const listProposalArtifactsInputSchema = z
  .object({
    channelId: z.string().min(1),
    proposalId: z.string().min(1),
  })
  .strict();

const proposalArtifactLinkSchema = z
  .object({
    linkId: z.string().min(1),
    proposalId: z.string().min(1),
    channelId: z.string().min(1),
    asset: creativeAssetSchema,
    createdAt: z.string(),
    createdVia: z.enum(CREATED_VIA_VALUES),
    agentApiVersion: z.string().nullable(),
  })
  .strict();

export const registerExternalArtifactOutputSchema = proposalArtifactLinkSchema;
export const listProposalArtifactsOutputSchema = z.object({ artifacts: z.array(proposalArtifactLinkSchema) }).strict();

export type CreateContentProposalInput = z.infer<typeof createContentProposalInputSchema>;
export type GetContentProposalInput = z.infer<typeof getContentProposalInputSchema>;
export type ListContentProposalsInput = z.infer<typeof listContentProposalsInputSchema>;
export type RegisterExternalArtifactInput = z.infer<typeof registerExternalArtifactInputSchema>;
export type ListProposalArtifactsInput = z.infer<typeof listProposalArtifactsInputSchema>;
