import { z } from "zod";
import { CREATED_VIA_VALUES, MAX_EVIDENCE_LIST_ITEMS, evidenceReferenceSchema } from "@/lib/shared-provenance";
import { creativeAssetSchema, registerAssetInputSchema } from "@/lib/asset-catalog/schemas";
export { parseWithSchema, formatZodError } from "./contracts";


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
//
// NOTE on what this restriction actually guarantees (RISK-58, `docs/TECHNICAL_DEBT.md`): the
// `referenceKind` enum alone is only a caller-supplied LABEL. Without the `.superRefine` below, an
// agent could label an arbitrary filesystem path `referenceKind: "url"` and have it accepted --
// the restriction would prevent nothing. The refinement below makes the `"url"` label actually
// mean an http(s) URL. `"external_artifact_id"` remains intentionally opaque (an arbitrary
// external-system identifier, never resolved by this application) and is NOT similarly validated
// -- callers must not assume any structural guarantee about its content beyond "non-empty string."
export const AGENT_ARTIFACT_REFERENCE_KINDS = ["url", "external_artifact_id"] as const;
const agentArtifactReferenceKindSchema = z.enum(AGENT_ARTIFACT_REFERENCE_KINDS);

// An independent review round found that checking only `new URL(value).protocol` validates
// Node's own lenient, WHATWG-normalized parse of `value` while the RAW string is what actually
// gets stored -- so a schemeless-authority string like "https:/etc/passwd" or
// "https:C:\Users\x\secret" parses (under Node's parser) to a synthesized host ("etc"/"c") and
// passes, even though it has no real authority component and other parsers (e.g. Python's
// `urllib.parse`) disagree with Node about what it means. This does not reopen filesystem access
// (no parse of an accepted value ever resolves to a `file:`/non-http(s) scheme), but it does not
// match this comment's own claim that the label is made to "actually mean an http(s) URL" either.
// Reject anything that isn't unambiguously `scheme://authority...` shaped, plus control
// characters, raw whitespace, and backslashes (none of which belong in a well-formed URL and each
// of which a different consumer could interpret differently than Node does).
function isWellFormedHttpUrl(value: string): boolean {
  if (/[\x00-\x20\x7f\\]/.test(value)) {
    return false;
  }
  if (!/^https?:\/\/[^/]/i.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const registerExternalArtifactInputSchema = registerAssetInputSchema
  .omit({ referenceKind: true })
  .extend({
    proposalId: z.string().min(1),
    referenceKind: agentArtifactReferenceKindSchema,
  })
  .superRefine((data, ctx) => {
    if (data.referenceKind !== "url") {
      return;
    }
    if (!isWellFormedHttpUrl(data.referenceValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "referenceValue must be a well-formed http(s) URL when referenceKind is \"url\"",
        path: ["referenceValue"],
      });
    }
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
