import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import {
  DomainError,
  type MarketChannelSnapshot,
  type MarketVideoSnapshot,
  type PublicChannelSnapshot,
  type PublicVideoSnapshot,
  type ResearchChannel,
  type ResearchEvidence,
  type ResolvedCredentials,
} from "./contracts";
import {
  addToWatchlistInputSchema,
  addToWatchlistOutputSchema,
  captureChannelSnapshotInputSchema,
  captureChannelSnapshotOutputSchema,
  fetchPublicSnapshotInputSchema,
  fetchPublicSnapshotOutputSchema,
  getWatchlistEntryContextOutputSchema,
  getWatchlistEntryInputSchema,
  getWatchlistEntryOutputSchema,
  listChannelSnapshotsInputSchema,
  listChannelSnapshotsOutputSchema,
  listEvidenceInputSchema,
  listEvidenceOutputSchema,
  listVideoSnapshotsInputSchema,
  listVideoSnapshotsOutputSchema,
  listWatchlistOutputSchema,
  parseWithSchema,
  recordChannelSnapshotInputSchema,
  recordChannelSnapshotOutputSchema,
  recordEvidenceInputSchema,
  recordEvidenceOutputSchema,
  recordVideoSnapshotInputSchema,
  recordVideoSnapshotOutputSchema,
  removeFromWatchlistInputSchema,
  runCollectionIfStaleInputSchema,
  runCollectionIfStaleOutputSchema,
} from "./schemas";
import type { CreatedVia } from "@/lib/shared-provenance";

/**
 * Builds the human-readable `research_evidence.observation` text for a public-snapshot fetch
 * (Phase 9 slice 3). Exported for direct unit testing (`AGENTS.md` §L: the "never fabricate"
 * requirement applies to the wording itself, not only to the underlying numbers) -- a hidden or
 * missing field is described as such, never silently omitted or presented as zero.
 *
 * Includes `title` (found missing by independent review, 2026-09-26 -- the plan's own §4 in-scope
 * bullet promises "title... where cheaply available," but the first version of this function
 * fetched `title` into `PublicChannelSnapshot` and then silently discarded it, leaving an operator
 * who added a channel by bare `UC...` id with no human-readable name anywhere in the Research
 * tab). `subscriberCount` is explicitly flagged as YouTube's own rounded approximation (the real
 * YouTube Data API v3 docs for `channels.list` document `statistics.subscriberCount` as "rounded
 * to three significant figures," never exact) -- `viewCount`/`videoCount` are not rounded and are
 * stated plainly.
 */
export function describePublicChannelSnapshot(snapshot: PublicChannelSnapshot): string {
  // Uses the real `hiddenSubscriberCount` flag (added for slice 9A), not `subscriberCount ===
  // null` alone -- a null count can also mean "absent/unparseable," a genuinely different, unknown
  // gap this wording should not misdescribe as "hidden" (independent review, 2026-09-26).
  const subscribers =
    snapshot.subscriberCount !== null
      ? `~${snapshot.subscriberCount} subscribers (YouTube reports this rounded to 3 significant figures, not an exact count)`
      : snapshot.hiddenSubscriberCount
        ? "subscriber count hidden"
        : "subscriber count unavailable";
  const views = snapshot.viewCount !== null ? `${snapshot.viewCount} total views` : "view count unavailable";
  const videos = snapshot.videoCount !== null ? `${snapshot.videoCount} videos` : "video count unavailable";
  // Falls back to the channel id when YouTube's own response omits `snippet.title` (the read
  // gateway's own `??` default is `""`, never fabricated -- found by independent review, round 2,
  // 2026-09-26: an empty string interpolated directly here would have rendered a confusing
  // `for ""` with nothing identifying the channel at all).
  const title = snapshot.title || snapshot.channelId;
  return `Public snapshot for "${title}": ${subscribers}, ${views}, ${videos}`;
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

type StoredMarketChannelSnapshotForService = {
  id: string;
  researchChannelId: string;
  observedAt: Date;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  source: string;
  createdVia: string;
};

type StoredMarketVideoSnapshotForService = {
  id: string;
  researchChannelId: string;
  videoId: string;
  observedAt: Date;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: Date | null;
  source: string;
  createdVia: string;
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

function toMarketChannelSnapshot(row: StoredMarketChannelSnapshotForService): MarketChannelSnapshot {
  return {
    snapshotId: row.id,
    researchChannelId: row.researchChannelId,
    observedAt: row.observedAt.toISOString(),
    subscriberCount: row.subscriberCount,
    viewCount: row.viewCount,
    videoCount: row.videoCount,
    hiddenSubscriberCount: row.hiddenSubscriberCount,
    source: row.source,
  };
}

function toMarketVideoSnapshot(row: StoredMarketVideoSnapshotForService): MarketVideoSnapshot {
  return {
    snapshotId: row.id,
    researchChannelId: row.researchChannelId,
    videoId: row.videoId,
    observedAt: row.observedAt.toISOString(),
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    source: row.source,
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
  deleteResearchChannel(id: string): Promise<void>;
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
    // Phase 9 slice 9B.
    listUploadsPlaylistFirstPageVideoIds(args: {
      credentials: ResolvedCredentials;
      uploadsPlaylistId: string;
    }): Promise<string[]>;
    getPublicVideoSnapshots(args: {
      credentials: ResolvedCredentials;
      videoIds: string[];
    }): Promise<PublicVideoSnapshot[]>;
  };
  // Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md).
  insertMarketChannelSnapshot(input: {
    id: string;
    researchChannelId: string;
    subscriberCount?: number | null;
    viewCount?: number | null;
    videoCount?: number | null;
    hiddenSubscriberCount?: boolean;
    source: string;
    createdVia: string;
  }): Promise<void>;
  listMarketChannelSnapshotsByChannel(researchChannelId: string): Promise<StoredMarketChannelSnapshotForService[]>;
  insertMarketVideoSnapshot(input: {
    id: string;
    researchChannelId: string;
    videoId: string;
    viewCount?: number | null;
    likeCount?: number | null;
    commentCount?: number | null;
    publishedAt?: Date | null;
    source: string;
    createdVia: string;
  }): Promise<void>;
  listMarketVideoSnapshotsByChannel(researchChannelId: string): Promise<StoredMarketVideoSnapshotForService[]>;
  // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md).
  /** Injectable so staleness/budget-window tests never depend on the real wall clock (advisor
   * review, before implementation -- mirrors `analytics/services.ts`'s own identical pattern). */
  clock: { now(): Date };
  getMarketIntelligenceDailyQuotaBudgetUnits(): Promise<number | null>;
  setMarketIntelligenceDailyQuotaBudgetUnits(units: number | null): Promise<void>;
  getMarketIntelligenceUnitsSpentSince(since: Date): Promise<number>;
  claimStaleResearchChannelsForCollection(args: {
    now: Date;
    staleCutoff: Date;
    claimExpiryCutoff: Date;
    excludeResearchChannelIds: string[];
  }): Promise<string[]>;
  releaseResearchChannelCollectionClaim(researchChannelId: string): Promise<void>;
  listRecentlyFailedResearchChannelIds(since: Date): Promise<string[]>;
  markResearchChannelAutoCollected(researchChannelId: string, at: Date): Promise<void>;
  insertMarketIntelligenceCollectionRun(input: {
    researchChannelId: string;
    status: "success" | "skipped_quota_limited" | "failed";
    unitsSpent: number;
    videosRequested?: number | null;
    videosReturned?: number | null;
    errorMessage?: string | null;
    ranAt?: Date;
  }): Promise<void>;
};

// Phase 9 slice 9B -- real YouTube Data API v3 quota costs (`channels.list`/`playlistItems.list`/
// `videos.list` are each a flat 1 unit regardless of requested parts, per the API's own published
// quota table); a channel is attempted for at most these 3 real calls (enumeration is capped to a
// single page, `getPublicVideoSnapshots` to a single ≤50-id batch -- see the read gateway's own
// `listUploadsPlaylistFirstPageVideoIds` doc comment for why cost stays exactly 1 unit per call,
// deterministically, never dependent on how many ids happen to come back).
const CHANNELS_LIST_UNIT_COST = 1;
const PLAYLIST_ITEMS_LIST_UNIT_COST = 1;
const VIDEOS_LIST_UNIT_COST = 1;

// A channel is stale after 24h with no successful collection -- deliberately a plain elapsed-time
// check, not Phase 8's own local-wall-clock-boundary rule (`AGENTS.md` §M: no cross-feature-module
// import of `analytics/staleness.ts` for a requirement this feature does not actually share).
const MARKET_INTELLIGENCE_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A claim older than this is treated as an abandoned (crashed) attempt and may be reclaimed --
// generous relative to a single channel's real work (at most 3 outbound HTTP calls).
const MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS = 15 * 60 * 1000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

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
     * operator who wants to change the reason calls `removeFromWatchlist` (below) and re-adds the
     * entry explicitly (no in-place update/rename operation exists yet -- only add and remove).
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
     * Removes a channel from the watchlist, along with every evidence row recorded against it
     * (added by independent review, 2026-09-26 -- the first version of this module had no way to
     * correct a mistyped `reason` or a wrong channel id, permanent for the life of the local
     * database). Idempotent-safe: removing an already-absent channel is a silent no-op, not an
     * error -- there is nothing destructive about a caller trying to remove something that is
     * already gone, and this matches this module's own `getResearchChannelById`-based existence
     * checks used elsewhere (never distinguishing "never existed" from "already removed").
     */
    async removeFromWatchlist(input: unknown): Promise<void> {
      const parsedInput = parseWithSchema(removeFromWatchlistInputSchema, input, "remove from watchlist input");
      await deps.deleteResearchChannel(parsedInput.channelId);
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
        // "high", not "confirmed" -- found by independent review (2026-09-26): subscriberCount is
        // YouTube's own rounded approximation (see describePublicChannelSnapshot's own doc
        // comment), so labeling this evidence "confirmed" overstates its precision. This narrows
        // but does not fully close the overstatement (found by round 2 of the same review): a
        // fully-null snapshot (e.g. a hidden subscriber count with no other stats available)
        // still gets stamped "high" today, even though it described nothing concrete. Not fixed
        // here -- `docs/roadmap/plans/PHASE_9_PLAN.md` §8 already leaves the confidence
        // vocabulary itself as an open question for a future revisit, and this specific edge case
        // belongs to that same still-open decision, not to a silent partial fix here.
        confidence: "high",
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(fetchPublicSnapshotOutputSchema, toResearchEvidence(row), "fetch public snapshot output");
    },

    /**
     * Single-channel deep dive: one watchlisted channel's own record plus its full evidence
     * history, by channelId. Added for Phase 9 slice 4
     * (`docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`) so MCP (`query_market_intelligence`) and CLI
     * (`agent market-intelligence`) share one implementation of this two-call join, instead of
     * each independently re-orchestrating `getWatchlistEntry`/`listEvidence` (found by independent
     * review -- the two call sites had already started to drift cosmetically).
     *
     * Deliberately does NOT call `getWatchlistEntry`/`listEvidence` above -- an earlier version did
     * (concurrently, via `Promise.all`), but independent review (round 2) found the actual defect
     * was TWO INDEPENDENT existence checks (`deps.getResearchChannelById` called once inside each
     * sibling function), not the concurrency itself: that duplication wasted a round-trip and opened
     * a race window (a `removeFromWatchlist` landing between the two independent reads could make
     * one branch see the channel and the other not), and the two calls' own
     * `RESEARCH_CHANNEL_NOT_AVAILABLE` errors carried different `details` key names (`channelId` vs
     * `researchChannelId`), making the response shape depend on which one happened to reject first.
     * A single existence check below, feeding both branches, closes both gaps -- the two reads
     * below are sequential only because `listResearchEvidenceByChannel` has no reason to run at all
     * once the channel is already known not to exist, not because concurrency is unsafe per se.
     */
    async getWatchlistEntryContext(input: unknown): Promise<{ channel: ResearchChannel; evidence: ResearchEvidence[] }> {
      const parsedInput = parseWithSchema(getWatchlistEntryInputSchema, input, "get watchlist entry context input");

      const channelRow = await deps.getResearchChannelById(parsedInput.channelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsedInput.channelId },
        });
      }

      const evidenceRows = await deps.listResearchEvidenceByChannel(parsedInput.channelId);

      return parseWithSchema(
        getWatchlistEntryContextOutputSchema,
        { channel: toResearchChannel(channelRow), evidence: evidenceRows.map(toResearchEvidence) },
        "get watchlist entry context output"
      );
    },

    /**
     * Manual, structured entry against an existing watchlist entry (Phase 9 slice 9A). Mirrors
     * `recordEvidence`'s own discipline exactly: `researchChannelId` must already be on the
     * watchlist, and an omitted numeric field is stored as `null`, never coerced to `0`.
     */
    async recordChannelSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketChannelSnapshot> {
      const parsedInput = parseWithSchema(recordChannelSnapshotInputSchema, input, "record channel snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record a channel snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketChannelSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        subscriberCount: parsedInput.subscriberCount ?? null,
        viewCount: parsedInput.viewCount ?? null,
        videoCount: parsedInput.videoCount ?? null,
        hiddenSubscriberCount: parsedInput.hiddenSubscriberCount ?? false,
        source: parsedInput.source,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordChannelSnapshotOutputSchema, toMarketChannelSnapshot(row), "record channel snapshot output");
    },

    async listChannelSnapshots(input: unknown): Promise<{ snapshots: MarketChannelSnapshot[] }> {
      const parsedInput = parseWithSchema(listChannelSnapshotsInputSchema, input, "list channel snapshots input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      const output = { snapshots: rows.map(toMarketChannelSnapshot) };
      return parseWithSchema(listChannelSnapshotsOutputSchema, output, "list channel snapshots output");
    },

    /**
     * Manual, structured entry for a video belonging to a watchlisted channel (Phase 9 slice 9A).
     * No automatic collection writes to this table yet -- real video-enumeration/collection is
     * 9B's own scope (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md` §1).
     */
    async recordVideoSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketVideoSnapshot> {
      const parsedInput = parseWithSchema(recordVideoSnapshotInputSchema, input, "record video snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record a video snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketVideoSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        videoId: parsedInput.videoId,
        viewCount: parsedInput.viewCount ?? null,
        likeCount: parsedInput.likeCount ?? null,
        commentCount: parsedInput.commentCount ?? null,
        publishedAt: parsedInput.publishedAt ? new Date(parsedInput.publishedAt) : null,
        source: parsedInput.source,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordVideoSnapshotOutputSchema, toMarketVideoSnapshot(row), "record video snapshot output");
    },

    async listVideoSnapshots(input: unknown): Promise<{ snapshots: MarketVideoSnapshot[] }> {
      const parsedInput = parseWithSchema(listVideoSnapshotsInputSchema, input, "list video snapshots input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.researchChannelId);
      const output = { snapshots: rows.map(toMarketVideoSnapshot) };
      return parseWithSchema(listVideoSnapshotsOutputSchema, output, "list video snapshots output");
    },

    /**
     * The one action in this slice that makes a real outbound YouTube API call (Phase 9 slice 9A)
     * -- reuses the identical `getPublicChannelSnapshot` read-gateway call `fetchPublicSnapshot`
     * (slice 3) already uses, per `docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md` §3's own design
     * decision. Deliberately does NOT touch `fetchPublicSnapshot`'s own existing behavior -- the
     * free-text `research_evidence` row it writes is completely unaffected; this is a pure
     * addition writing a separate, structured `market_channel_snapshots` row from the same live
     * response.
     */
    async captureChannelSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketChannelSnapshot> {
      const parsedInput = parseWithSchema(captureChannelSnapshotInputSchema, input, "capture channel snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot capture a channel snapshot for a channel that is not on the watchlist",
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
      await deps.insertMarketChannelSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        subscriberCount: snapshot.subscriberCount,
        viewCount: snapshot.viewCount,
        videoCount: snapshot.videoCount,
        // YouTube's own real flag, not re-guessed from `subscriberCount === null` -- that would
        // also misclassify a genuinely absent/unparseable count as "hidden" (found by independent
        // review, 2026-09-26; fixed at the root by widening `PublicChannelSnapshot` itself, both
        // here and in the read gateway, rather than re-guessing downstream).
        hiddenSubscriberCount: snapshot.hiddenSubscriberCount,
        source: "youtube.channels.list",
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(captureChannelSnapshotOutputSchema, toMarketChannelSnapshot(row), "capture channel snapshot output");
    },

    /**
     * The operator-set daily unit budget (Phase 9 slice 9B, plan §4) -- `null`/unset means the
     * repeatable auto-refresh is off. Exposed here (a thin passthrough) rather than left as a
     * direct `db.ts` import inside `/api/settings/route.ts` (found by this module's own mechanical
     * `PHASE9-INV-02` inventory test, which is exactly the guard this indirection exists to
     * satisfy): a generic settings route reaching straight into a feature module's own db.ts
     * functions is the identical reach-around `AGENTS.md` §D/§M forbids for every other domain,
     * even though this particular setting is a plain number with no validation of its own to add.
     */
    async getDailyQuotaBudgetUnits(): Promise<number | null> {
      return deps.getMarketIntelligenceDailyQuotaBudgetUnits();
    },

    async setDailyQuotaBudgetUnits(units: number | null): Promise<void> {
      await deps.setMarketIntelligenceDailyQuotaBudgetUnits(units);
    },

    /**
     * The repeatable, budget-aware auto-refresh trigger (Phase 9 slice 9B): every watchlisted
     * channel stale by more than 24h gets one attempt -- channel snapshot (± its uploads playlist
     * id, one `channels.list` call), up to 50 newest video snapshots (one `playlistItems.list` +
     * one `videos.list` call) -- gated by the operator's own daily unit budget
     * (`getMarketIntelligenceDailyQuotaBudgetUnits`; `null`/unset means auto-collection is off).
     *
     * Deliberately does NOT call the public `captureChannelSnapshot` above (advisor review, before
     * implementation): that action's own output schema strips `uploadsPlaylistId` (a field
     * `MarketChannelSnapshot`, the PERSISTED contract, has no reason to carry) and it would
     * re-resolve credentials once per channel instead of once for the whole run. This method calls
     * `deps.youtubeApi`/`deps.insertMarketChannelSnapshot` directly instead, on the one
     * already-resolved credential set.
     *
     * Concurrency: claims every eligible channel atomically in ONE call
     * (`claimStaleResearchChannelsForCollection`, a single `UPDATE ... WHERE ... RETURNING`) before
     * any real work starts -- a second concurrent call (e.g. two dashboard tabs) sees none of them
     * still claimable and does nothing, closing the race a per-channel-only claim would still leave
     * open against a run-scoped shared budget. Each claim is released the moment that channel's own
     * attempt reaches ANY terminal outcome, in a `finally`, so a crash mid-run leaves at most an
     * abandoned claim (self-healing after `MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS`), never a
     * permanently stuck channel.
     *
     * Budget accounting is per real outbound call, not per assumed channel cost: the moment
     * `remaining` can no longer cover the NEXT call, that channel's row is stamped
     * `skipped_quota_limited` with whatever it honestly spent so far (0 if blocked on its very
     * first call), every other still-claimed channel is released WITHOUT a row of its own (found by
     * advisor review: writing one identical row per remaining stale channel on every single
     * dashboard mount, once the budget is merely small, would spam the audit log for no new
     * information beyond "the budget ran out here"), and the whole run stops -- a later channel
     * never jumps the queue ahead of one already skipped this run.
     *
     * A channel whose most recent run failed within the last 24h is excluded from this run's claim
     * entirely (`listRecentlyFailedResearchChannelIds`) -- without this, a permanently broken
     * channel (deleted, made private) would spend at least one real unit on every mount, forever.
     * `last_auto_collected_at` is set ONLY on a channel's own full success, never as a side effect
     * of the overall run -- a channel this run could not fully process stays stale for next time.
     */
    async runCollectionIfStale(input: unknown): Promise<{
      attempted: number;
      succeeded: number;
      failed: number;
      quotaLimited: number;
      unitsSpent: number;
    }> {
      const parsedInput = parseWithSchema(runCollectionIfStaleInputSchema, input, "run collection if stale input");
      const zeroed = { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 };

      const budget = await deps.getMarketIntelligenceDailyQuotaBudgetUnits();
      if (budget === null) {
        return parseWithSchema(runCollectionIfStaleOutputSchema, zeroed, "run collection if stale output");
      }

      const now = deps.clock.now();
      const spentToday = await deps.getMarketIntelligenceUnitsSpentSince(startOfUtcDay(now));
      let remaining = budget - spentToday;
      if (remaining <= 0) {
        return parseWithSchema(runCollectionIfStaleOutputSchema, zeroed, "run collection if stale output");
      }

      // Credentials must resolve BEFORE any channel is claimed -- a scope/credential failure must
      // never leave a channel claimed with nothing actually attempted (advisor review).
      const credentials = await deps.authResolver.resolve({
        credentialRef: parsedInput.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });

      const staleCutoff = new Date(now.getTime() - MARKET_INTELLIGENCE_STALE_WINDOW_MS);
      const claimExpiryCutoff = new Date(now.getTime() - MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS);
      const recentlyFailedIds = await deps.listRecentlyFailedResearchChannelIds(staleCutoff);
      const claimedIds = await deps.claimStaleResearchChannelsForCollection({
        now,
        staleCutoff,
        claimExpiryCutoff,
        excludeResearchChannelIds: recentlyFailedIds,
      });

      if (claimedIds.length === 0) {
        return parseWithSchema(runCollectionIfStaleOutputSchema, zeroed, "run collection if stale output");
      }

      let attempted = 0;
      let succeeded = 0;
      let failedCount = 0;
      let quotaLimited = 0;
      let unitsSpentTotal = 0;

      for (let i = 0; i < claimedIds.length; i++) {
        const researchChannelId = claimedIds[i];

        if (remaining < CHANNELS_LIST_UNIT_COST) {
          attempted += 1;
          quotaLimited += 1;
          await deps.insertMarketIntelligenceCollectionRun({
            researchChannelId,
            status: "skipped_quota_limited",
            unitsSpent: 0,
            ranAt: now,
          });
          await deps.releaseResearchChannelCollectionClaim(researchChannelId);
          for (let j = i + 1; j < claimedIds.length; j++) {
            await deps.releaseResearchChannelCollectionClaim(claimedIds[j]);
          }
          break;
        }

        attempted += 1;
        let unitsSpentThisChannel = 0;
        let videosRequested: number | null = null;
        let videosReturned: number | null = null;

        try {
          const snapshot = await deps.youtubeApi.getPublicChannelSnapshot({ credentials, channelId: researchChannelId });
          unitsSpentThisChannel += CHANNELS_LIST_UNIT_COST;
          remaining -= CHANNELS_LIST_UNIT_COST;

          if (!snapshot) {
            throw new Error("YouTube reports no public channel for this id");
          }

          await deps.insertMarketChannelSnapshot({
            id: deps.idGenerator(),
            researchChannelId,
            subscriberCount: snapshot.subscriberCount,
            viewCount: snapshot.viewCount,
            videoCount: snapshot.videoCount,
            hiddenSubscriberCount: snapshot.hiddenSubscriberCount,
            source: "youtube.channels.list",
            createdVia: "web_ui",
          });

          if (snapshot.uploadsPlaylistId && remaining >= PLAYLIST_ITEMS_LIST_UNIT_COST) {
            const videoIds = await deps.youtubeApi.listUploadsPlaylistFirstPageVideoIds({
              credentials,
              uploadsPlaylistId: snapshot.uploadsPlaylistId,
            });
            unitsSpentThisChannel += PLAYLIST_ITEMS_LIST_UNIT_COST;
            remaining -= PLAYLIST_ITEMS_LIST_UNIT_COST;
            videosRequested = videoIds.length;
            videosReturned = 0;

            if (videoIds.length > 0 && remaining >= VIDEOS_LIST_UNIT_COST) {
              const videoSnapshots: PublicVideoSnapshot[] = await deps.youtubeApi.getPublicVideoSnapshots({
                credentials,
                videoIds,
              });
              unitsSpentThisChannel += VIDEOS_LIST_UNIT_COST;
              remaining -= VIDEOS_LIST_UNIT_COST;
              videosReturned = videoSnapshots.length;

              for (const videoSnapshot of videoSnapshots) {
                await deps.insertMarketVideoSnapshot({
                  id: deps.idGenerator(),
                  researchChannelId,
                  videoId: videoSnapshot.videoId,
                  viewCount: videoSnapshot.viewCount,
                  likeCount: videoSnapshot.likeCount,
                  commentCount: videoSnapshot.commentCount,
                  publishedAt: videoSnapshot.publishedAt ? new Date(videoSnapshot.publishedAt) : null,
                  source: "youtube.videos.list",
                  createdVia: "web_ui",
                });
              }
            }
          }

          await deps.markResearchChannelAutoCollected(researchChannelId, now);
          await deps.insertMarketIntelligenceCollectionRun({
            researchChannelId,
            status: "success",
            unitsSpent: unitsSpentThisChannel,
            videosRequested,
            videosReturned,
            ranAt: now,
          });
          succeeded += 1;
        } catch (error) {
          await deps.insertMarketIntelligenceCollectionRun({
            researchChannelId,
            status: "failed",
            unitsSpent: unitsSpentThisChannel,
            errorMessage: error instanceof Error ? error.message : String(error),
            ranAt: now,
          });
          failedCount += 1;
        } finally {
          await deps.releaseResearchChannelCollectionClaim(researchChannelId);
          unitsSpentTotal += unitsSpentThisChannel;
        }
      }

      return parseWithSchema(
        runCollectionIfStaleOutputSchema,
        { attempted, succeeded, failed: failedCount, quotaLimited, unitsSpent: unitsSpentTotal },
        "run collection if stale output"
      );
    },
  };
}

export type MarketIntelligenceServices = ReturnType<typeof createMarketIntelligenceServices>;
