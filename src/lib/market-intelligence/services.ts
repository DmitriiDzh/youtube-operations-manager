import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import {
  DomainError,
  type PublicChannelSnapshot,
  type ResearchChannel,
  type ResearchEvidence,
  type ResolvedCredentials,
} from "./contracts";
import {
  addToWatchlistInputSchema,
  addToWatchlistOutputSchema,
  fetchPublicSnapshotInputSchema,
  fetchPublicSnapshotOutputSchema,
  getWatchlistEntryInputSchema,
  getWatchlistEntryOutputSchema,
  listEvidenceInputSchema,
  listEvidenceOutputSchema,
  listWatchlistOutputSchema,
  parseWithSchema,
  recordEvidenceInputSchema,
  recordEvidenceOutputSchema,
} from "./schemas";
import type { CreatedVia } from "@/lib/shared-provenance";

/**
 * Builds the human-readable `research_evidence.observation` text for a public-snapshot fetch
 * (Phase 9 slice 3). Exported for direct unit testing (`AGENTS.md` §L: the "never fabricate"
 * requirement applies to the wording itself, not only to the underlying numbers) -- a hidden or
 * missing field is described as such, never silently omitted or presented as zero.
 */
export function describePublicChannelSnapshot(snapshot: PublicChannelSnapshot): string {
  const subscribers =
    snapshot.subscriberCount !== null ? `${snapshot.subscriberCount} subscribers` : "subscriber count hidden";
  const views = snapshot.viewCount !== null ? `${snapshot.viewCount} total views` : "view count unavailable";
  const videos = snapshot.videoCount !== null ? `${snapshot.videoCount} videos` : "video count unavailable";
  return `Public snapshot: ${subscribers}, ${views}, ${videos}`;
}

type StoredResearchChannelForService = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
};

type StoredResearchEvidenceForService = {
  id: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  createdVia: string;
  collectedAt: Date;
};

function toResearchChannel(row: StoredResearchChannelForService): ResearchChannel {
  return {
    channelId: row.id,
    handleOrUrl: row.handleOrUrl,
    reason: row.reason,
    addedAt: row.addedAt.toISOString(),
  };
}

function toResearchEvidence(row: StoredResearchEvidenceForService): ResearchEvidence {
  return {
    evidenceId: row.id,
    researchChannelId: row.researchChannelId,
    observation: row.observation,
    source: row.source,
    confidence: row.confidence,
    collectedAt: row.collectedAt.toISOString(),
  };
}

type ServiceDependencies = {
  idGenerator(): string;
  insertResearchChannel(input: {
    id: string;
    handleOrUrl?: string | null;
    reason: string;
    createdVia: string;
  }): Promise<void>;
  listResearchChannels(): Promise<StoredResearchChannelForService[]>;
  getResearchChannelById(id: string): Promise<StoredResearchChannelForService | null>;
  insertResearchEvidence(input: {
    id: string;
    researchChannelId: string;
    observation: string;
    source: string;
    confidence?: string | null;
    createdVia: string;
  }): Promise<void>;
  listResearchEvidenceByChannel(researchChannelId: string): Promise<StoredResearchEvidenceForService[]>;
  authResolver: {
    resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials>;
  };
  youtubeApi: {
    getPublicChannelSnapshot(args: {
      credentials: ResolvedCredentials;
      channelId: string;
    }): Promise<PublicChannelSnapshot | null>;
  };
};

export function createMarketIntelligenceServices(deps: ServiceDependencies) {
  return {
    /**
     * Adds a channel the operator does not (necessarily) own to the research watchlist
     * (`docs/roadmap/plans/PHASE_9_PLAN.md` §5/§7). `callOrigin` is SERVER-STAMPED at the
     * API/MCP/CLI call site, never taken from the parsed input -- same attestation discipline as
     * `content-proposals`' `createContentProposal` (Phase 7 slice G, owner spec §22).
     *
     * Rejects a duplicate `channelId` with `RESEARCH_CHANNEL_ALREADY_WATCHED` rather than
     * silently creating a second row or silently overwriting the existing `reason` -- an
     * operator who wants to change the reason removes and re-adds the entry explicitly (no
     * update/remove operation exists yet in this slice; see the plan's §6 slice 2).
     */
    async addToWatchlist(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchChannel> {
      const parsedInput = parseWithSchema(addToWatchlistInputSchema, input, "add to watchlist input");

      const existing = await deps.getResearchChannelById(parsedInput.channelId);
      if (existing) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_ALREADY_WATCHED",
          message: "This channel is already on the research watchlist",
          details: { channelId: parsedInput.channelId },
        });
      }

      await deps.insertResearchChannel({
        id: parsedInput.channelId,
        handleOrUrl: parsedInput.handleOrUrl ?? null,
        reason: parsedInput.reason,
        createdVia: callOrigin.createdVia,
      });

      // Guaranteed to exist -- this call itself just inserted it, under the same connection this
      // read uses.
      const row = (await deps.getResearchChannelById(parsedInput.channelId))!;

      return parseWithSchema(addToWatchlistOutputSchema, toResearchChannel(row), "add to watchlist output");
    },

    async listWatchlist(): Promise<{ channels: ResearchChannel[] }> {
      const rows = await deps.listResearchChannels();
      const output = { channels: rows.map(toResearchChannel) };
      return parseWithSchema(listWatchlistOutputSchema, output, "list watchlist output");
    },

    async getWatchlistEntry(input: unknown): Promise<ResearchChannel> {
      const parsedInput = parseWithSchema(getWatchlistEntryInputSchema, input, "get watchlist entry input");

      const row = await deps.getResearchChannelById(parsedInput.channelId);
      if (!row) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsedInput.channelId },
        });
      }

      return parseWithSchema(getWatchlistEntryOutputSchema, toResearchChannel(row), "get watchlist entry output");
    },

    /**
     * Records one publicly-observable fact against an existing watchlist entry. Never a
     * private-analytics-shaped figure and never a profitability/ranking conclusion (plan §4/§7) --
     * enforcement of that is at the call site (e.g. slice 3's public-snapshot fetch action), this
     * function itself only persists whatever `observation`/`source` it is given.
     */
    async recordEvidence(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchEvidence> {
      const parsedInput = parseWithSchema(recordEvidenceInputSchema, input, "record evidence input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record evidence for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertResearchEvidence({
        id,
        researchChannelId: parsedInput.researchChannelId,
        observation: parsedInput.observation,
        source: parsedInput.source,
        confidence: parsedInput.confidence ?? null,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordEvidenceOutputSchema, toResearchEvidence(row), "record evidence output");
    },

    async listEvidence(input: unknown): Promise<{ evidence: ResearchEvidence[] }> {
      const parsedInput = parseWithSchema(listEvidenceInputSchema, input, "list evidence input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      const output = { evidence: rows.map(toResearchEvidence) };
      return parseWithSchema(listEvidenceOutputSchema, output, "list evidence output");
    },

    /**
     * Fetches a real, live public snapshot (subscriber/view/video counts) for a watchlisted
     * channel via `channels.list` and records it as a new evidence row (Phase 9 slice 3). The one
     * action in this module that makes a real outbound YouTube API call -- everything else here
     * is pure local storage. Never records a private-analytics-shaped figure and never a
     * conclusion (plan §4/§7) -- only the raw, sourced public numbers YouTube itself returns.
     */
    async fetchPublicSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchEvidence> {
      const parsedInput = parseWithSchema(fetchPublicSnapshotInputSchema, input, "fetch public snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot fetch a public snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const credentials = await deps.authResolver.resolve({
        credentialRef: parsedInput.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });

      const snapshot = await deps.youtubeApi.getPublicChannelSnapshot({
        credentials,
        channelId: parsedInput.researchChannelId,
      });

      if (!snapshot) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "YouTube reports no public channel for this id",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertResearchEvidence({
        id,
        researchChannelId: parsedInput.researchChannelId,
        observation: describePublicChannelSnapshot(snapshot),
        source: "youtube.channels.list",
        confidence: "confirmed",
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(fetchPublicSnapshotOutputSchema, toResearchEvidence(row), "fetch public snapshot output");
    },
  };
}

export type MarketIntelligenceServices = ReturnType<typeof createMarketIntelligenceServices>;
