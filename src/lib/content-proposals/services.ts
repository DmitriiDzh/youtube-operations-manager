import { DomainError, type ContentProposal, type ContentProposalBrief, type CreatedVia, type EvidenceReference } from "./contracts";
import {
  createContentProposalInputSchema,
  createContentProposalOutputSchema,
  getContentProposalInputSchema,
  getContentProposalOutputSchema,
  listContentProposalsInputSchema,
  listContentProposalsOutputSchema,
  parseWithSchema,
} from "./schemas";

type StoredContentProposalForService = {
  id: string;
  channelId: string;
  objective: string | null;
  topicConcept: string | null;
  rationale: string | null;
  evidenceJson: string | null;
  briefJson: string | null;
  referenceVideoIdsJson: string | null;
  referenceAssetIdsJson: string | null;
  createdAt: Date;
  createdVia: string;
  agentApiVersion: string | null;
};

function parseJsonArray<T>(json: string | null): T[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function parseJsonObject<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function toContentProposal(row: StoredContentProposalForService): ContentProposal {
  return {
    proposalId: row.id,
    channelId: row.channelId,
    objective: row.objective,
    topicConcept: row.topicConcept,
    rationale: row.rationale,
    evidence: parseJsonArray<EvidenceReference>(row.evidenceJson),
    brief: parseJsonObject<ContentProposalBrief>(row.briefJson),
    referenceVideoIds: parseJsonArray<string>(row.referenceVideoIdsJson),
    referenceAssetIds: parseJsonArray<string>(row.referenceAssetIdsJson),
    createdAt: row.createdAt.toISOString(),
    // Cast: this module's own INSERT path is the only writer and always stamps a real `CreatedVia`
    // (never taken from caller input) -- a value read back here is always one of the real members.
    createdVia: row.createdVia as CreatedVia,
    agentApiVersion: row.agentApiVersion,
  };
}

type ServiceDependencies = {
  idGenerator(): string;
  insertProposal(input: {
    id: string;
    channelId: string;
    objective: string | null;
    topicConcept: string | null;
    rationale: string | null;
    evidenceJson: string | null;
    briefJson: string | null;
    referenceVideoIdsJson: string | null;
    referenceAssetIdsJson: string | null;
    createdVia: CreatedVia;
    agentApiVersion: string | null;
  }): Promise<void>;
  listProposalsByChannel(channelId: string): Promise<StoredContentProposalForService[]>;
  getProposalById(proposalId: string): Promise<StoredContentProposalForService | null>;
  // Reused unchanged from `changesets`' own channel/video store adapter (AGENTS.md §D), same
  // convention `asset-catalog`'s own `registerAsset` already established.
  videoBelongsToChannel(channelId: string, videoId: string): Promise<boolean>;
  // Reused from `asset-catalog`'s own channel-scoped `getAssetContext` (AGENTS.md §D) -- never a
  // second, parallel asset-ownership check.
  assetBelongsToChannel(channelId: string, assetId: string): Promise<boolean>;
};

export function createContentProposalServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §18: create a structured Content Proposal using application context. DRAFT
     * permission -- Codex/any agent may create one, never approve/execute anything from it (there
     * is no approve/execute concept for this domain at all, see contracts.ts's own doc comment).
     * `callOrigin` is SERVER-STAMPED at the MCP/CLI call site (owner spec §22), never taken from
     * the parsed input -- same attestation discipline as `ai-localization`'s
     * `createChangeSetFromGeneration` (Phase 7 slice F).
     */
    async createContentProposal(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<ContentProposal> {
      const parsedInput = parseWithSchema(createContentProposalInputSchema, input, "create content proposal input");

      for (const videoId of parsedInput.referenceVideoIds ?? []) {
        const belongs = await deps.videoBelongsToChannel(parsedInput.channelId, videoId);
        if (!belongs) {
          throw new DomainError({
            code: "INVALID_CONTEXT_REQUEST",
            message: "referenceVideoIds contains a video that does not belong to the requested channel",
            details: { channelId: parsedInput.channelId, videoId },
          });
        }
      }

      for (const assetId of parsedInput.referenceAssetIds ?? []) {
        const belongs = await deps.assetBelongsToChannel(parsedInput.channelId, assetId);
        if (!belongs) {
          throw new DomainError({
            code: "INVALID_CONTEXT_REQUEST",
            message: "referenceAssetIds contains an asset that does not belong to the requested channel",
            details: { channelId: parsedInput.channelId, assetId },
          });
        }
      }

      const id = deps.idGenerator();
      await deps.insertProposal({
        id,
        channelId: parsedInput.channelId,
        objective: parsedInput.objective ?? null,
        topicConcept: parsedInput.topicConcept ?? null,
        rationale: parsedInput.rationale ?? null,
        evidenceJson: parsedInput.evidence ? JSON.stringify(parsedInput.evidence) : null,
        briefJson: parsedInput.brief ? JSON.stringify(parsedInput.brief) : null,
        referenceVideoIdsJson: parsedInput.referenceVideoIds ? JSON.stringify(parsedInput.referenceVideoIds) : null,
        referenceAssetIdsJson: parsedInput.referenceAssetIds ? JSON.stringify(parsedInput.referenceAssetIds) : null,
        createdVia: callOrigin.createdVia,
        agentApiVersion: callOrigin.agentApiVersion ?? null,
      });

      // Guaranteed to exist -- `id` is a fresh id this call itself just inserted, under the same
      // connection this read uses.
      const row = (await deps.getProposalById(id))!;

      return parseWithSchema(createContentProposalOutputSchema, toContentProposal(row), "create content proposal output");
    },

    /**
     * Channel-scoping is deliberately NOT done here -- mirrors `agent-operations` slice B's
     * convention (`getChannelContext`/`getVideoContext`): the MCP/CLI caller checks
     * `channelAccessCore.assertActiveChannel` before calling this.
     */
    async listContentProposals(input: unknown): Promise<{ proposals: ContentProposal[] }> {
      const parsedInput = parseWithSchema(listContentProposalsInputSchema, input, "list content proposals input");

      const rows = await deps.listProposalsByChannel(parsedInput.channelId);
      const output = { proposals: rows.map(toContentProposal) };
      return parseWithSchema(listContentProposalsOutputSchema, output, "list content proposals output");
    },

    /** Same channel-scoping note as `listContentProposals` above. */
    async getContentProposal(input: unknown): Promise<ContentProposal> {
      const parsedInput = parseWithSchema(getContentProposalInputSchema, input, "get content proposal input");

      const row = await deps.getProposalById(parsedInput.proposalId);
      // Reports the SAME error for "doesn't exist" and "exists but belongs to another channel"
      // -- never lets a caller distinguish the two (would otherwise leak which proposal ids exist
      // for a channel this caller has no access to), same discipline as `getAssetContext`.
      if (!row || row.channelId !== parsedInput.channelId) {
        throw new DomainError({
          code: "CONTENT_PROPOSAL_NOT_AVAILABLE",
          message: "Content proposal not found for the requested channel",
          details: { channelId: parsedInput.channelId, proposalId: parsedInput.proposalId },
        });
      }

      return parseWithSchema(getContentProposalOutputSchema, toContentProposal(row), "get content proposal output");
    },
  };
}

export type ContentProposalServices = ReturnType<typeof createContentProposalServices>;
