import { z } from "zod";

// Shared vocabulary for attesting/citing the origin of an agent-created object (owner spec §22,
// §13), extracted here (`AGENTS.md` §M) after being needed by more than one otherwise-unrelated
// feature module: `ai-localization` (Phase 7 slice F) and `content-proposals` (Phase 7 slice G).
// Neither of those modules may depend on the other, and this module owns no business logic of
// its own -- only the shared literal vocabulary and its bounds -- so it has no dependencies on
// either and stays a leaf module both can safely import.

/**
 * Which transport actually created a piece of agent-created content (owner spec §22) -- the
 * single, canonical definition of this vocabulary. Every module that needs this type imports it
 * from here (`AGENTS.md` §D) rather than retyping the same three literals.
 */
export const CREATED_VIA_VALUES = ["mcp", "cli", "web_ui"] as const;
export type CreatedVia = (typeof CREATED_VIA_VALUES)[number];
export const createdViaSchema = z.enum(CREATED_VIA_VALUES);

/**
 * One agent-cited piece of external research or comparable-video evidence backing a generated
 * proposal (owner spec §13). Caller-supplied and never independently verified by the server that
 * stores it -- `AGENTS.md` §B/§G's "AI proposes" principle applied to citations, not just to the
 * proposal content itself. `sourceType` distinguishes research the agent performed outside the
 * application (`external_research`) from figures already owned by the channel
 * (`channel_analytics`, `comparable_video`) so a reader can tell "the agent looked this up" from
 * "this app already knew this" -- owner spec §13's explicit ask.
 */
export const EVIDENCE_SOURCE_TYPES = ["external_research", "channel_analytics", "comparable_video", "other"] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];
export const evidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);

// Bounded-length only, never a validation of the CONTENT of an agent's citation (AGENTS.md §B).
export const MAX_EVIDENCE_TEXT_LENGTH = 2000;
export const MAX_EVIDENCE_EXCERPT_LENGTH = 1000;

export type EvidenceReference = {
  url: string;
  retrievedAt: string;
  description: string;
  claimSupported: string;
  sourceType: EvidenceSourceType;
  excerpt?: string | null;
};

export const evidenceReferenceSchema = z
  .object({
    url: z.string().min(1).max(MAX_EVIDENCE_TEXT_LENGTH),
    retrievedAt: z.string().min(1),
    description: z.string().min(1).max(MAX_EVIDENCE_TEXT_LENGTH),
    claimSupported: z.string().min(1).max(MAX_EVIDENCE_TEXT_LENGTH),
    sourceType: evidenceSourceTypeSchema,
    excerpt: z.string().max(MAX_EVIDENCE_EXCERPT_LENGTH).nullable().optional(),
  })
  .strict();
