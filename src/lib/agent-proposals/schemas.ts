import { z } from "zod";
import { AGENT_PROPOSAL_KINDS, AGENT_PROPOSAL_STATUSES } from "./contracts";
export { parseWithSchema } from "./contracts";

// A canonical `UC...` id: resolving a handle or URL would need a YouTube call, which a proposal never makes (kept per module, as in
// market-intelligence's own schemas).
const youtubeChannelIdSchema = z.string().regex(/^UC[a-zA-Z0-9_-]{22}$/, "must be a YouTube channel id (UC...)");
const ourChannelIdSchema = z.string().min(1).max(64);

export const proposalTextSchema = z.string().trim().min(1, "text is required: what, why and the evidence").max(4000);

/** What the Producer sends. `payload` is checked per kind below. */
export const submitProducerProposalInputSchema = z
  .object({
    channelId: ourChannelIdSchema,
    kind: z.enum(AGENT_PROPOSAL_KINDS),
    text: proposalTextSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const watchlistEntryPayloadSchema = z.object({ researchChannelId: youtubeChannelIdSchema }).strict();

export const proposalPayloadSchemas = {
  "watchlist.add": z
    .object({
      competitorChannelId: youtubeChannelIdSchema,
      handleOrUrl: z.string().trim().min(1).max(500).optional(),
      reason: z.string().trim().min(1, "reason is required: why the channel is watched").max(2000),
    })
    .strict(),
  "watchlist.unfollow": watchlistEntryPayloadSchema,
  "watchlist.pause": watchlistEntryPayloadSchema,
  "watchlist.resume": watchlistEntryPayloadSchema,
  "watchlist.delete": watchlistEntryPayloadSchema,
  "hypothesis.add": z
    .object({
      statement: z.string().trim().min(1, "statement is required").max(2000),
      evidenceNotes: z.string().trim().min(1, "evidenceNotes is required").max(4000),
    })
    .strict(),
} as const;

export const listProducerProposalsInputSchema = z
  .object({
    channelId: ourChannelIdSchema.optional(),
    status: z.enum(AGENT_PROPOSAL_STATUSES).optional(),
    includeDone: z.boolean().optional(),
  })
  .strict();

export const markProposalsDoneInputSchema = z.object({ proposalIds: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict();

export const listOwnerProposalsInputSchema = z.object({ view: z.enum(["pending", "decided"]) }).strict();

export const approveProposalInputSchema = z.object({ proposalId: z.string().min(1).max(100) }).strict();

export const rejectProposalInputSchema = z
  .object({
    proposalId: z.string().min(1).max(100),
    comment: z.string().trim().min(1, "a comment is required: the reason, for the agent").max(2000),
  })
  .strict();
