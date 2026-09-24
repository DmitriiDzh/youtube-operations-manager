import type { CreativeAsset } from "@/lib/asset-catalog";
import {
  DomainError,
  type ContentProposal,
  type ContentProposalBrief,
  type CreatedVia,
  type EvidenceReference,
  type ProposalArtifactLink,
} from "./contracts";
import {
  createContentProposalInputSchema,
  createContentProposalOutputSchema,
  getContentProposalInputSchema,
  getContentProposalOutputSchema,
  listContentProposalsInputSchema,
  listContentProposalsOutputSchema,
  listProposalArtifactsInputSchema,
  listProposalArtifactsOutputSchema,
  parseWithSchema,
  registerExternalArtifactInputSchema,
  registerExternalArtifactOutputSchema,
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

type StoredArtifactLinkForService = {
  id: string;
  proposalId: string;
  assetId: string;
  createdAt: Date;
  createdVia: string;
  agentApiVersion: string | null;
};

function toProposalArtifactLink(link: StoredArtifactLinkForService, asset: CreativeAsset, channelId: string): ProposalArtifactLink {
  return {
    linkId: link.id,
    proposalId: link.proposalId,
    channelId,
    asset,
    createdAt: link.createdAt.toISOString(),
    // Cast: this module's own INSERT path is the only writer and always stamps a real `CreatedVia`
    // (never taken from caller input) -- a value read back here is always one of the real members.
    createdVia: link.createdVia as CreatedVia,
    agentApiVersion: link.agentApiVersion,
  };
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
  // Phase 7 slice G2 (owner spec §19) -- delegates to `asset-catalog`'s own `registerAsset`
  // unchanged (AGENTS.md §D: this module never inserts into `creative_assets` itself).
  registerAsset(input: {
    channelId: string;
    assetType: string;
    referenceKind: string;
    referenceValue: string;
    title?: string;
    description?: string;
    linkedVideoId?: string;
    provenance?: Record<string, unknown>;
  }): Promise<CreativeAsset>;
  insertArtifactLink(input: {
    id: string;
    proposalId: string;
    assetId: string;
    createdVia: CreatedVia;
    agentApiVersion?: string | null;
  }): Promise<void>;
  getArtifactLinkById(linkId: string): Promise<StoredArtifactLinkForService | null>;
  listArtifactLinksByProposal(proposalId: string): Promise<StoredArtifactLinkForService[]>;
  // Reused from `asset-catalog`'s own `getAssetContext` (AGENTS.md §D) -- hydrates a link's full
  // asset record for output; never a second, parallel asset read.
  getAssetById(channelId: string, assetId: string): Promise<CreativeAsset | null>;
};

export function createContentProposalServices(deps: ServiceDependencies) {
  // Shared by `getContentProposal`/`listProposalArtifacts`/`registerExternalArtifact` -- reports
  // the SAME error for "doesn't exist" and "exists but belongs to another channel" -- never lets
  // a caller distinguish the two (would otherwise leak which proposal ids exist for a channel
  // this caller has no access to), same discipline as `getAssetContext`.
  async function requireProposalForChannel(channelId: string, proposalId: string): Promise<StoredContentProposalForService> {
    const row = await deps.getProposalById(proposalId);
    if (!row || row.channelId !== channelId) {
      throw new DomainError({
        code: "CONTENT_PROPOSAL_NOT_AVAILABLE",
        message: "Content proposal not found for the requested channel",
        details: { channelId, proposalId },
      });
    }
    return row;
  }

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
      const row = await requireProposalForChannel(parsedInput.channelId, parsedInput.proposalId);
      return parseWithSchema(getContentProposalOutputSchema, toContentProposal(row), "get content proposal output");
    },

    /**
     * Owner spec §19: "a lightweight way for external agent workflows to return created
     * artifacts to the system." Delegates the actual asset catalog insert to `asset-catalog`'s
     * own `registerAsset` (AGENTS.md §D) -- this function only creates the LINK between that
     * asset and the requesting proposal. `referenceKind` is restricted to
     * `AGENT_ARTIFACT_REFERENCE_KINDS` by the input schema itself (never `local_path` -- owner
     * spec §17). `callOrigin` is SERVER-STAMPED, same discipline as `createContentProposal`.
     *
     * Not wrapped in a single transaction with the underlying `registerAsset` call
     * (`docs/TECHNICAL_DEBT.md` RISK-56 -- the same non-atomic-multi-write pattern already
     * accepted for `createChangeSetFromGeneration`'s Change-Set-plus-provenance write).
     */
    async registerExternalArtifact(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<ProposalArtifactLink> {
      const parsedInput = parseWithSchema(registerExternalArtifactInputSchema, input, "register external artifact input");
      await requireProposalForChannel(parsedInput.channelId, parsedInput.proposalId);

      const asset = await deps.registerAsset({
        channelId: parsedInput.channelId,
        assetType: parsedInput.assetType,
        referenceKind: parsedInput.referenceKind,
        referenceValue: parsedInput.referenceValue,
        title: parsedInput.title,
        description: parsedInput.description,
        linkedVideoId: parsedInput.linkedVideoId,
        provenance: parsedInput.provenance,
      });

      const id = deps.idGenerator();
      await deps.insertArtifactLink({
        id,
        proposalId: parsedInput.proposalId,
        assetId: asset.assetId,
        createdVia: callOrigin.createdVia,
        agentApiVersion: callOrigin.agentApiVersion ?? null,
      });

      // Guaranteed to exist -- `id` is a fresh id this call itself just inserted, under the same
      // connection this read uses.
      const link = (await deps.getArtifactLinkById(id))!;

      return parseWithSchema(
        registerExternalArtifactOutputSchema,
        toProposalArtifactLink(link, asset, parsedInput.channelId),
        "register external artifact output"
      );
    },

    /** Same channel-scoping note as `listContentProposals` above (proposal ownership is still
     * checked explicitly, since a proposalId is caller-supplied and must be verified against
     * `channelId` regardless). */
    async listProposalArtifacts(input: unknown): Promise<{ artifacts: ProposalArtifactLink[] }> {
      const parsedInput = parseWithSchema(listProposalArtifactsInputSchema, input, "list proposal artifacts input");
      await requireProposalForChannel(parsedInput.channelId, parsedInput.proposalId);

      const links = await deps.listArtifactLinksByProposal(parsedInput.proposalId);
      const artifacts: ProposalArtifactLink[] = [];
      for (const link of links) {
        const asset = await deps.getAssetById(parsedInput.channelId, link.assetId);
        // Never fabricate a link's asset -- an FK-consistent database should never hit this, but
        // if it somehow did, silently drop the orphaned link rather than crash the whole read.
        if (!asset) continue;
        artifacts.push(toProposalArtifactLink(link, asset, parsedInput.channelId));
      }

      return parseWithSchema(listProposalArtifactsOutputSchema, { artifacts }, "list proposal artifacts output");
    },
  };
}

export type ContentProposalServices = ReturnType<typeof createContentProposalServices>;
