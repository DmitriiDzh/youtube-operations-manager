// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_9_PLAN.md §7, written from the
// requirement before this file's own implementation was read line-by-line (AGENTS.md §L):
//
// AC-MI-01: an empty `reason` is rejected before it ever reaches storage.
// AC-MI-02: a `research_evidence` row always has a non-empty `source`/`observation`; missing
//           either is rejected before storage.
// AC-MI-03: `createdVia` cannot be supplied by the caller's own input -- it is SERVER-STAMPED via
//           a separate `callOrigin` parameter (mirrors `content-proposals`' `createContentProposal`
//           convention); an input payload that tries to smuggle it in through the public schema
//           is rejected outright (the schema is `.strict()`, no such field exists on it).
// AC-MI-04: adding a channel already on the watchlist is rejected
//           (RESEARCH_CHANNEL_ALREADY_WATCHED), never silently creating a second row or silently
//           overwriting the existing reason.
// AC-MI-05: recording evidence against a channel that isn't on the watchlist is rejected
//           (RESEARCH_CHANNEL_NOT_AVAILABLE).
// AC-MI-06: `channelId` must be a canonical YouTube channel id (`UC` + 22 chars) -- a bare
//           handle/URL/malformed id is rejected before storage (plan §8: handle resolution is a
//           later slice, never accepted as the primary key in this one).
// AC-MI-07: successful add/list/record/list-evidence round trips return the expected shape.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { createMarketIntelligenceServices, describePublicChannelSnapshot } from "./services";
import { isDomainError, type PublicChannelSnapshot, type PublicVideoSnapshot, type ResolvedCredentials } from "./contracts";

const VALID_CHANNEL_ID = "UC1234567890123456789012"; // "UC" + 22 chars, matches the schema regex
const OTHER_VALID_CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

type Row = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
  lastAutoCollectedAt: Date | null;
  collectionClaimedAt: Date | null;
};

type CollectionRunRow = {
  researchChannelId: string;
  status: "success" | "skipped_quota_limited" | "failed";
  unitsSpent: number;
  videosRequested: number | null;
  videosReturned: number | null;
  errorMessage: string | null;
  ranAt: Date;
};

type EvidenceRow = {
  id: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  createdVia: string;
  collectedAt: Date;
};

type ChannelSnapshotRow = {
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

type VideoSnapshotRow = {
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

function createFakeStore() {
  const channels = new Map<string, Row>();
  const evidence: EvidenceRow[] = [];
  const channelSnapshots: ChannelSnapshotRow[] = [];
  const videoSnapshots: VideoSnapshotRow[] = [];
  const collectionRuns: CollectionRunRow[] = [];
  let quotaBudget: number | null = null;
  let nextId = 1;

  return {
    channels,
    evidence,
    channelSnapshots,
    videoSnapshots,
    collectionRuns,
    setQuotaBudget(units: number | null) {
      quotaBudget = units;
    },
    idGenerator: () => `evidence-${nextId++}`,
    async insertResearchChannel(input: { id: string; handleOrUrl?: string | null; reason: string; createdVia: string }) {
      channels.set(input.id, {
        id: input.id,
        handleOrUrl: input.handleOrUrl ?? null,
        reason: input.reason,
        createdVia: input.createdVia,
        addedAt: new Date(),
        lastAutoCollectedAt: null,
        collectionClaimedAt: null,
      });
    },
    async listResearchChannels() {
      return [...channels.values()];
    },
    async getResearchChannelById(id: string) {
      return channels.get(id) ?? null;
    },
    async deleteResearchChannel(id: string) {
      channels.delete(id);
      for (let i = evidence.length - 1; i >= 0; i--) {
        if (evidence[i].researchChannelId === id) evidence.splice(i, 1);
      }
    },
    async insertResearchEvidence(input: {
      id: string;
      researchChannelId: string;
      observation: string;
      source: string;
      confidence?: string | null;
      createdVia: string;
    }) {
      evidence.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        observation: input.observation,
        source: input.source,
        confidence: input.confidence ?? null,
        createdVia: input.createdVia,
        collectedAt: new Date(),
      });
    },
    async listResearchEvidenceByChannel(researchChannelId: string) {
      return evidence.filter((row) => row.researchChannelId === researchChannelId);
    },
    async insertMarketChannelSnapshot(input: {
      id: string;
      researchChannelId: string;
      subscriberCount?: number | null;
      viewCount?: number | null;
      videoCount?: number | null;
      hiddenSubscriberCount?: boolean;
      source: string;
      createdVia: string;
    }) {
      channelSnapshots.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        observedAt: new Date(),
        subscriberCount: input.subscriberCount ?? null,
        viewCount: input.viewCount ?? null,
        videoCount: input.videoCount ?? null,
        hiddenSubscriberCount: input.hiddenSubscriberCount ?? false,
        source: input.source,
        createdVia: input.createdVia,
      });
    },
    async listMarketChannelSnapshotsByChannel(researchChannelId: string) {
      return channelSnapshots.filter((row) => row.researchChannelId === researchChannelId);
    },
    async insertMarketVideoSnapshot(input: {
      id: string;
      researchChannelId: string;
      videoId: string;
      viewCount?: number | null;
      likeCount?: number | null;
      commentCount?: number | null;
      publishedAt?: Date | null;
      source: string;
      createdVia: string;
    }) {
      videoSnapshots.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        videoId: input.videoId,
        observedAt: new Date(),
        viewCount: input.viewCount ?? null,
        likeCount: input.likeCount ?? null,
        commentCount: input.commentCount ?? null,
        publishedAt: input.publishedAt ?? null,
        source: input.source,
        createdVia: input.createdVia,
      });
    },
    async listMarketVideoSnapshotsByChannel(researchChannelId: string) {
      return videoSnapshots.filter((row) => row.researchChannelId === researchChannelId);
    },
    // Phase 9 slice 9B -- mirrors db.ts's own atomic-claim semantics closely enough for a
    // single-threaded test (the real atomicity is proven against the actual SQLite driver in
    // db.test.ts, AGENTS.md §L -- a fake in-memory store can only prove the fake is
    // self-consistent, never that a real concurrent UPDATE is genuinely a compare-and-swap).
    async getMarketIntelligenceDailyQuotaBudgetUnits() {
      return quotaBudget;
    },
    async setMarketIntelligenceDailyQuotaBudgetUnits(units: number | null) {
      quotaBudget = units;
    },
    async getMarketIntelligenceUnitsSpentSince(since: Date) {
      return collectionRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).reduce((sum, row) => sum + row.unitsSpent, 0);
    },
    async claimStaleResearchChannelsForCollection(args: {
      now: Date;
      staleCutoff: Date;
      claimExpiryCutoff: Date;
      excludeResearchChannelIds: string[];
    }) {
      const claimed: string[] = [];
      for (const [id, row] of channels) {
        const isStale = row.lastAutoCollectedAt === null || row.lastAutoCollectedAt.getTime() < args.staleCutoff.getTime();
        const isUnclaimed =
          row.collectionClaimedAt === null || row.collectionClaimedAt.getTime() < args.claimExpiryCutoff.getTime();
        if (isStale && isUnclaimed && !args.excludeResearchChannelIds.includes(id)) {
          row.collectionClaimedAt = args.now;
          claimed.push(id);
        }
      }
      return claimed;
    },
    async releaseResearchChannelCollectionClaim(researchChannelId: string) {
      const row = channels.get(researchChannelId);
      if (row) row.collectionClaimedAt = null;
    },
    async listRecentlyFailedResearchChannelIds(since: Date) {
      const ids = new Set<string>();
      for (const row of collectionRuns) {
        if (row.status === "failed" && row.ranAt.getTime() >= since.getTime()) ids.add(row.researchChannelId);
      }
      return [...ids];
    },
    async markResearchChannelAutoCollected(researchChannelId: string, at: Date) {
      const row = channels.get(researchChannelId);
      if (row) row.lastAutoCollectedAt = at;
    },
    async insertMarketIntelligenceCollectionRun(input: {
      researchChannelId: string;
      status: "success" | "skipped_quota_limited" | "failed";
      unitsSpent: number;
      videosRequested?: number | null;
      videosReturned?: number | null;
      errorMessage?: string | null;
      ranAt?: Date;
    }) {
      collectionRuns.push({
        researchChannelId: input.researchChannelId,
        status: input.status,
        unitsSpent: input.unitsSpent,
        videosRequested: input.videosRequested ?? null,
        videosReturned: input.videosReturned ?? null,
        errorMessage: input.errorMessage ?? null,
        ranAt: input.ranAt ?? new Date(),
      });
    },
  };
}

function createFixture(overrides?: {
  publicSnapshot?: PublicChannelSnapshot | null;
  resolveError?: Error;
  now?: Date;
  getPublicChannelSnapshotImpl?: (args: {
    credentials: ResolvedCredentials;
    channelId: string;
  }) => Promise<PublicChannelSnapshot | null>;
  uploadsPlaylistVideoIds?: string[];
  publicVideoSnapshots?: PublicVideoSnapshot[];
}) {
  const store = createFakeStore();
  const resolveCalls: unknown[] = [];
  const snapshotCalls: unknown[] = [];
  const playlistCalls: unknown[] = [];
  const videoSnapshotCalls: unknown[] = [];
  let currentNow = overrides?.now ?? new Date();
  const services = createMarketIntelligenceServices({
    ...store,
    clock: { now: () => currentNow },
    authResolver: {
      async resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }) {
        resolveCalls.push(args);
        if (overrides?.resolveError) throw overrides.resolveError;
        return { accessToken: "fake-access-token", refreshToken: "fake-refresh-token" } as ResolvedCredentials;
      },
    },
    youtubeApi: {
      async getPublicChannelSnapshot(args: { credentials: ResolvedCredentials; channelId: string }) {
        snapshotCalls.push(args);
        if (overrides?.getPublicChannelSnapshotImpl) return overrides.getPublicChannelSnapshotImpl(args);
        return overrides?.publicSnapshot !== undefined
          ? overrides.publicSnapshot
          : {
              channelId: args.channelId,
              title: "Fetched Channel",
              subscriberCount: 100,
              hiddenSubscriberCount: false,
              viewCount: 200,
              videoCount: 3,
              uploadsPlaylistId: null,
            };
      },
      async listUploadsPlaylistFirstPageVideoIds(args: { credentials: ResolvedCredentials; uploadsPlaylistId: string }) {
        playlistCalls.push(args);
        return overrides?.uploadsPlaylistVideoIds ?? [];
      },
      async getPublicVideoSnapshots(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
        videoSnapshotCalls.push(args);
        return overrides?.publicVideoSnapshots ?? [];
      },
    },
  });
  return {
    store,
    services,
    resolveCalls,
    snapshotCalls,
    playlistCalls,
    videoSnapshotCalls,
    setNow(date: Date) {
      currentNow = date;
    },
  };
}

test("AC-MI-01: addToWatchlist rejects an empty reason before storage", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () => services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.channels.size, 0);
});

test("AC-MI-02: recordEvidence rejects a missing observation/source before storage", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor in the same niche" }, { createdVia: "web_ui" });

  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "Had 10k subscribers", source: "" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.evidence.length, 0);
});

test("AC-MI-03: createdVia cannot be smuggled in through the public input -- it is server-stamped only", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.addToWatchlist(
        { channelId: VALID_CHANNEL_ID, reason: "Test", createdVia: "mcp" } as unknown,
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  // The one legitimate way createdVia is set: the second, separate callOrigin parameter.
  const created = await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Test" }, { createdVia: "cli" });
  assert.equal(created.channelId, VALID_CHANNEL_ID);
});

test("AC-MI-04: adding a channel already on the watchlist is rejected, never silently duplicated or overwritten", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Original reason" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Different reason" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_ALREADY_WATCHED"
  );

  assert.equal(store.channels.size, 1);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.reason, "Original reason");
});

test("AC-MI-05: recording evidence against a channel not on the watchlist is rejected", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "Had 10k subscribers", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("AC-MI-06: channelId must be a canonical YouTube channel id, not a bare handle/URL", async () => {
  const { services } = createFixture();

  for (const badId of ["@somehandle", "https://youtube.com/@somehandle", "not-a-channel-id", ""]) {
    await assert.rejects(
      () => services.addToWatchlist({ channelId: badId, reason: "Test" }, { createdVia: "web_ui" }),
      (error: unknown) => isDomainError(error) && error.code === "validation_failed"
    );
  }
});

test("AC-MI-07: add/list/record/list-evidence round trips return the expected shape", async () => {
  const { services } = createFixture();

  const added = await services.addToWatchlist(
    { channelId: VALID_CHANNEL_ID, handleOrUrl: "@example", reason: "Fast-growing in the same niche" },
    { createdVia: "web_ui" }
  );
  assert.deepEqual(added, {
    channelId: VALID_CHANNEL_ID,
    handleOrUrl: "@example",
    reason: "Fast-growing in the same niche",
    addedAt: added.addedAt,
  });

  const list = await services.listWatchlist();
  assert.equal(list.channels.length, 1);
  assert.equal(list.channels[0].channelId, VALID_CHANNEL_ID);

  const fetched = await services.getWatchlistEntry({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(fetched, added);

  const evidence = await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Published 3 videos this week", source: "manual observation", confidence: "high" },
    { createdVia: "web_ui" }
  );
  assert.equal(evidence.researchChannelId, VALID_CHANNEL_ID);
  assert.equal(evidence.confidence, "high");

  const evidenceList = await services.listEvidence({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(evidenceList.evidence.length, 1);
  assert.deepEqual(evidenceList.evidence[0], evidence);
});

test("AC-MI-08: getWatchlistEntry/listEvidence for an unknown channel report RESEARCH_CHANNEL_NOT_AVAILABLE", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getWatchlistEntry({ channelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  await assert.rejects(
    () => services.listEvidence({ researchChannelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 3 -- fetchPublicSnapshot (docs/roadmap/plans/PHASE_9_PLAN.md §6/§7).
// ---------------------------------------------------------------------------

test("AC-MI-09: fetchPublicSnapshot rejects a channel that is not on the watchlist, without resolving credentials", async () => {
  const { services, resolveCalls } = createFixture();

  await assert.rejects(
    () =>
      services.fetchPublicSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(resolveCalls.length, 0, "must never resolve credentials for a channel that isn't watchlisted");
});

test("AC-MI-10: fetchPublicSnapshot resolves credentials with YOUTUBE_READ_SCOPE, fetches by researchChannelId, and records a 'high'-confidence evidence row stamped from callOrigin", async () => {
  const { store, services, resolveCalls, snapshotCalls } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Competitor",
      subscriberCount: 5000,
      hiddenSubscriberCount: false,
      viewCount: 90000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor" }, { createdVia: "web_ui" });

  const evidence = await services.fetchPublicSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.deepEqual(resolveCalls, [{ credentialRef: { userId: "u1" }, requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"] }]);
  assert.deepEqual(snapshotCalls, [{ credentials: { accessToken: "fake-access-token", refreshToken: "fake-refresh-token" }, channelId: VALID_CHANNEL_ID }]);
  assert.equal(evidence.source, "youtube.channels.list");
  assert.equal(evidence.confidence, "high");
  assert.equal(
    evidence.observation,
    'Public snapshot for "Competitor": ~5000 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 90000 total views, 12 videos'
  );
  assert.equal(store.evidence.length, 1);
  assert.equal(store.evidence[0].createdVia, "web_ui");
});

test("AC-MI-11: fetchPublicSnapshot rejects when YouTube reports no public channel for this id, and records nothing", async () => {
  const { store, services } = createFixture({ publicSnapshot: null });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor" }, { createdVia: "web_ui" });

  await assert.rejects(
    () =>
      services.fetchPublicSnapshot(
        { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(store.evidence.length, 0);
});

// AC-MI-12: describePublicChannelSnapshot's wording, derived independently from YOUTUBE's own
// documented "hiddenSubscriberCount"/field-omission semantics -- never a fabricated 0 or a silent
// omission for a value YouTube did not actually report.
test("AC-MI-12: describePublicChannelSnapshot reports the title and every field, describes a null field honestly instead of fabricating a number, and flags subscriberCount as YouTube's own rounded approximation (real API docs: 'rounded to three significant figures')", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: 12300,
      hiddenSubscriberCount: false,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": ~12300 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: null,
      hiddenSubscriberCount: true,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": subscriber count hidden, 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: 0,
      hiddenSubscriberCount: false,
      viewCount: null,
      videoCount: null,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": ~0 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), view count unavailable, video count unavailable'
  );
});

// Phase 9 slice 9A -- proves the fix for the exact ambiguity independent review found: a null
// subscriberCount for a reason OTHER than YouTube hiding it (a genuinely absent/unparseable stat)
// must never be described as "hidden" (a specific, different, real fact).
test("AC-MI-12c: describePublicChannelSnapshot describes a null subscriberCount as 'unavailable', not 'hidden', when hiddenSubscriberCount is false", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: null,
      hiddenSubscriberCount: false,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": subscriber count unavailable, 456000 total views, 42 videos'
  );
});

// Found by independent review, round 2 (2026-09-26): an empty title (YouTube's own response
// omitted snippet.title -- the read gateway's `??` default is "") must never render as a
// confusing `for ""` with nothing identifying the channel.
test("AC-MI-12b: describePublicChannelSnapshot falls back to the channel id when title is empty", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "",
      subscriberCount: 100,
      hiddenSubscriberCount: false,
      viewCount: 200,
      videoCount: 3,
      uploadsPlaylistId: null,
    }),
    `Public snapshot for "${VALID_CHANNEL_ID}": ~100 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 200 total views, 3 videos`
  );
});

// ---------------------------------------------------------------------------
// removeFromWatchlist -- added by independent review, 2026-09-26 (docs/roadmap/plans/PHASE_9_PLAN.md).
// ---------------------------------------------------------------------------

test("AC-MI-13: removeFromWatchlist deletes the channel and every evidence row recorded against it", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Test" }, { createdVia: "web_ui" });
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Something", source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(store.channels.size, 1);
  assert.equal(store.evidence.length, 1);

  await services.removeFromWatchlist({ channelId: VALID_CHANNEL_ID });

  assert.equal(store.channels.size, 0);
  assert.equal(store.evidence.length, 0);
  await assert.rejects(
    () => services.getWatchlistEntry({ channelId: VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("AC-MI-14: removeFromWatchlist is a silent no-op for a channel that was never on the watchlist (idempotent, mirrors localization's removeTrackedLanguage convention)", async () => {
  const { store, services } = createFixture();
  await services.removeFromWatchlist({ channelId: OTHER_VALID_CHANNEL_ID });
  assert.equal(store.channels.size, 0);
});

test("AC-MI-15: after removal, the same channel id can be added back (never blocked by a stale duplicate check)", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "First" }, { createdVia: "web_ui" });
  await services.removeFromWatchlist({ channelId: VALID_CHANNEL_ID });

  const readded = await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Second" }, { createdVia: "web_ui" });
  assert.equal(readded.reason, "Second");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 4 -- getWatchlistEntryContext (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md §7).
// Added so MCP's query_market_intelligence and CLI's `agent market-intelligence` share one
// implementation of the "channel + its full evidence history" join, instead of each
// independently re-orchestrating getWatchlistEntry+listEvidence (found by independent review --
// the two call sites had already started to drift cosmetically).
// ---------------------------------------------------------------------------

test("AC-MI-16: getWatchlistEntryContext rejects a channel not on the watchlist with RESEARCH_CHANNEL_NOT_AVAILABLE and a stable details.channelId shape", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getWatchlistEntryContext({ channelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE" &&
      // Pins the exact `details` shape -- independent review (round 2, 2026-09-26) found an
      // earlier version of this function delegated to getWatchlistEntry/listEvidence
      // concurrently, whose two RESEARCH_CHANNEL_NOT_AVAILABLE errors carried different
      // `details` key names (`channelId` vs `researchChannelId`), making the response
      // non-deterministic depending on which one settled first.
      JSON.stringify(error.details) === JSON.stringify({ channelId: OTHER_VALID_CHANNEL_ID })
  );
});

test("AC-MI-17: getWatchlistEntryContext returns the channel's own record with an empty evidence array when none has been recorded yet", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });

  assert.equal(result.channel.channelId, VALID_CHANNEL_ID);
  assert.deepEqual(result.evidence, []);
});

test("AC-MI-18: getWatchlistEntryContext returns every recorded evidence row for 2+ rows, in insertion order", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "First observation", source: "manual observation" },
    { createdVia: "web_ui" }
  );
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Second observation", source: "manual observation" },
    { createdVia: "web_ui" }
  );

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });

  assert.equal(result.channel.channelId, VALID_CHANNEL_ID);
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(
    result.evidence.map((e) => e.observation),
    ["First observation", "Second observation"]
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9A -- service-layer acceptance criteria from
// docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md §5 (derived-metrics.test.ts covers the pure
// delta/velocity functions themselves; these tests cover the service layer that stores and
// retrieves the raw rows those functions consume).
// ---------------------------------------------------------------------------

test("AC-9A-06: recordChannelSnapshot rejects a channel not on the watchlist, before any insert", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () =>
      services.recordChannelSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, subscriberCount: 100, source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(store.channelSnapshots.length, 0);
});

test("AC-9A-07: recordChannelSnapshot/listChannelSnapshots never coerce an omitted numeric field to 0", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const recorded = await services.recordChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, viewCount: 5000, source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(recorded.subscriberCount, null, "an omitted field must be null, never a fabricated 0");
  assert.equal(recorded.videoCount, null);
  assert.equal(recorded.viewCount, 5000);
  assert.equal(recorded.hiddenSubscriberCount, false, "default must be false when not specified");

  const list = await services.listChannelSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(list.snapshots.length, 1);
  assert.equal(list.snapshots[0].subscriberCount, null);
});

test("AC-9A-08: recordVideoSnapshot rejects a channel not on the watchlist; listVideoSnapshots never fabricates an omitted field", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.recordVideoSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, videoId: "v1", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );

  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  const recorded = await services.recordVideoSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, videoId: "v1", viewCount: 200, source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(recorded.likeCount, null);
  assert.equal(recorded.commentCount, null);
  assert.equal(recorded.publishedAt, null);

  const list = await services.listVideoSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(list.snapshots.length, 1);
  assert.equal(list.snapshots[0].videoId, "v1");
});

test("AC-9A-09: captureChannelSnapshot stores hiddenSubscriberCount:true and subscriberCount:null together when YouTube hides the count", async () => {
  const { services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: null,
      hiddenSubscriberCount: true,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.captureChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(result.subscriberCount, null);
  assert.equal(result.hiddenSubscriberCount, true);
  assert.equal(result.viewCount, 9000);
  assert.equal(result.videoCount, 12);
  assert.equal(result.source, "youtube.channels.list");
});

// Found by independent review, 2026-09-26: an earlier version inferred hiddenSubscriberCount from
// `subscriberCount === null` alone, which would have mislabeled THIS exact case (null for a
// different, unrelated reason) as "hidden." Proves the fix uses the real gateway-reported flag.
test("AC-9A-09b: captureChannelSnapshot stores hiddenSubscriberCount:false when subscriberCount is null for a reason other than YouTube hiding it", async () => {
  const { services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: null,
      hiddenSubscriberCount: false,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.captureChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(result.subscriberCount, null);
  assert.equal(result.hiddenSubscriberCount, false, "must not fabricate 'hidden' for an unrelated null reason");
});

test("AC-9A-10: captureChannelSnapshot never touches research_evidence -- fetchPublicSnapshot's own rows stay unaffected", async () => {
  const { store, services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: 100,
      hiddenSubscriberCount: false,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  await services.fetchPublicSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(store.evidence.length, 1, "fetchPublicSnapshot's own free-text evidence row must exist as before");

  await services.captureChannelSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });

  assert.equal(store.evidence.length, 1, "captureChannelSnapshot must never write to research_evidence");
  assert.equal(store.channelSnapshots.length, 1, "captureChannelSnapshot writes exactly its own structured row");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §9) -- acceptance criteria for
// runCollectionIfStale, drafted from the plan's own §9 before this file's own implementation was
// read line-by-line (AGENTS.md §L).
// ---------------------------------------------------------------------------

const FULL_SNAPSHOT_WITH_VIDEO: PublicChannelSnapshot = {
  channelId: VALID_CHANNEL_ID,
  title: "Competitor",
  subscriberCount: 1000,
  hiddenSubscriberCount: false,
  viewCount: 50000,
  videoCount: 10,
  uploadsPlaylistId: "UU_TEST_UPLOADS",
};

test("AC-9B-01: a never-collected channel is stale; a successful run sets last_auto_collected_at, and a second run within 24h does not re-process it", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, setNow } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: "2026-01-01T00:00:00.000Z", viewCount: 10, likeCount: 1, commentCount: 0 }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const first = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(first, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 3 });
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt?.getTime(), now.getTime());

  setNow(new Date(now.getTime() + 23 * 60 * 60 * 1000));
  const second = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(second, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 }, "a channel collected less than 24h ago must not be re-processed");
});

test("AC-9B-02: with budget 0/unset, runCollectionIfStale makes zero real calls and marks nothing", async () => {
  const { store, services, snapshotCalls } = createFixture({ publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const unsetResult = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(unsetResult, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });

  store.setQuotaBudget(0);
  const zeroResult = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(zeroResult, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });

  assert.equal(snapshotCalls.length, 0, "must never call getPublicChannelSnapshot when the budget is unset or zero");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null);
});

test("AC-9B-03: given a budget covering exactly one channel's 3-call cost and two stale channels, the run processes the first and records skipped_quota_limited for the second, leaving it stale", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(3);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 0, quotaLimited: 1, unitsSpent: 3 });

  const succeededRuns = store.collectionRuns.filter((r) => r.status === "success");
  const skippedRuns = store.collectionRuns.filter((r) => r.status === "skipped_quota_limited");
  assert.equal(succeededRuns.length, 1);
  assert.equal(succeededRuns[0].unitsSpent, 3);
  assert.equal(skippedRuns.length, 1);
  assert.equal(skippedRuns[0].unitsSpent, 0, "a channel never even attempted must show 0 spent, not a fabricated number");

  const succeededChannelId = succeededRuns[0].researchChannelId;
  const skippedChannelId = skippedRuns[0].researchChannelId;
  assert.notEqual(succeededChannelId, skippedChannelId);
  assert.ok(store.channels.get(succeededChannelId)?.lastAutoCollectedAt, "the processed channel must be marked collected");
  assert.equal(store.channels.get(skippedChannelId)?.lastAutoCollectedAt, null, "the skipped channel must stay stale for next time");
  assert.equal(store.channels.get(skippedChannelId)?.collectionClaimedAt, null, "the skipped channel's claim must be released, never left stuck");
});

test("AC-9B-04: a video id present in the enumeration but absent from videos.list is reflected as videosReturned < videosRequested, never assumed deleted", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1", "v2_missing"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });

  const [run] = store.collectionRuns;
  assert.equal(run.status, "success");
  assert.equal(run.videosRequested, 2);
  assert.equal(run.videosReturned, 1, "the gap must be reported honestly, never silently corrected or assumed deleted");
  assert.equal(store.videoSnapshots.length, 1, "only the video YouTube actually returned gets a stored snapshot");
});

test("AC-9B-05: a channel already claimed by a concurrent run in progress is excluded from this run's claim entirely", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  // Simulates a concurrent second dashboard tab's run claiming this channel moments ago, still in progress.
  store.channels.get(VALID_CHANNEL_ID)!.collectionClaimedAt = new Date(now.getTime() - 60 * 1000);

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0, "an already-claimed channel must never receive a second concurrent attempt");
});

test("AC-9B-06: when the budget covers only the channel snapshot call, the channel still succeeds with videosRequested/videosReturned left null, never fabricated", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, playlistCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(1);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 1 });
  assert.equal(playlistCalls.length, 0, "must never issue a playlistItems.list call it can't afford");

  const [run] = store.collectionRuns;
  assert.equal(run.videosRequested, null);
  assert.equal(run.videosReturned, null);
  assert.ok(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, "a channel snapshot alone is still a real, successful refresh of that channel");
});

test("AC-9B-07: a channel whose most recent run failed within the last 24h is excluded from this run's claim (retry backoff)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "failed",
    unitsSpent: 1,
    videosRequested: null,
    videosReturned: null,
    errorMessage: "boom",
    ranAt: new Date(now.getTime() - 60 * 60 * 1000),
  });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0, "a recently-failed channel must not be retried on every single run");
});

test("AC-9B-08: a channel YouTube reports no public channel for is recorded as failed, without aborting other stale channels in the same run", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    getPublicChannelSnapshotImpl: async (args) => (args.channelId === VALID_CHANNEL_ID ? null : FULL_SNAPSHOT_WITH_VIDEO),
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 1, quotaLimited: 0, unitsSpent: 4 });

  const failedRun = store.collectionRuns.find((r) => r.status === "failed");
  assert.ok(failedRun?.errorMessage, "a failure must record a real, non-empty error message");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null);
  assert.ok(store.channels.get(OTHER_VALID_CHANNEL_ID)?.lastAutoCollectedAt, "one channel's failure must never abort the rest of the run");
});

test("AC-9B-09: a credential/scope resolution failure propagates, and claims no channel (no channel is left stuck mid-attempt)", async () => {
  const { store, services } = createFixture({ resolveError: new Error("insufficient scope") });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await assert.rejects(() => services.runCollectionIfStale({ credentialRef: { userId: "u1" } }), /insufficient scope/);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.collectionClaimedAt, null, "a credential failure must happen before any claim is taken");
  assert.equal(store.collectionRuns.length, 0);
});

// Found necessary by the write-path-inventory guard (PHASE9-INV-02): a generic settings route
// must never import getMarketIntelligenceDailyQuotaBudgetUnits/setMarketIntelligenceDailyQuotaBudgetUnits
// from db.ts directly -- these two thin passthroughs are what it calls instead.
test("AC-9B-10: getDailyQuotaBudgetUnits/setDailyQuotaBudgetUnits round-trip through the injected store, defaulting to null", async () => {
  const { store, services } = createFixture();
  assert.equal(await services.getDailyQuotaBudgetUnits(), null);

  await services.setDailyQuotaBudgetUnits(25);
  assert.equal(await services.getDailyQuotaBudgetUnits(), 25);
  assert.equal(store.channels.size, 0, "must never touch any watchlist state -- a pure setting passthrough");

  await services.setDailyQuotaBudgetUnits(null);
  assert.equal(await services.getDailyQuotaBudgetUnits(), null);
});
