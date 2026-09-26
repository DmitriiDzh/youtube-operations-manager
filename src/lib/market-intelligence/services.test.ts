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
import { isDomainError, type PublicChannelSnapshot, type ResolvedCredentials } from "./contracts";

const VALID_CHANNEL_ID = "UC1234567890123456789012"; // "UC" + 22 chars, matches the schema regex
const OTHER_VALID_CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

type Row = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
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
  let nextId = 1;

  return {
    channels,
    evidence,
    channelSnapshots,
    videoSnapshots,
    idGenerator: () => `evidence-${nextId++}`,
    async insertResearchChannel(input: { id: string; handleOrUrl?: string | null; reason: string; createdVia: string }) {
      channels.set(input.id, {
        id: input.id,
        handleOrUrl: input.handleOrUrl ?? null,
        reason: input.reason,
        createdVia: input.createdVia,
        addedAt: new Date(),
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
  };
}

function createFixture(overrides?: {
  publicSnapshot?: PublicChannelSnapshot | null;
  resolveError?: Error;
}) {
  const store = createFakeStore();
  const resolveCalls: unknown[] = [];
  const snapshotCalls: unknown[] = [];
  const services = createMarketIntelligenceServices({
    ...store,
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
        return overrides?.publicSnapshot !== undefined
          ? overrides.publicSnapshot
          : { channelId: args.channelId, title: "Fetched Channel", subscriberCount: 100, hiddenSubscriberCount: false, viewCount: 200, videoCount: 3 };
      },
    },
  });
  return { store, services, resolveCalls, snapshotCalls };
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
    publicSnapshot: { channelId: VALID_CHANNEL_ID, title: "Competitor", subscriberCount: 5000, hiddenSubscriberCount: false, viewCount: 90000, videoCount: 12 },
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
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: 12300, hiddenSubscriberCount: false, viewCount: 456000, videoCount: 42 }),
    'Public snapshot for "x": ~12300 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: null, hiddenSubscriberCount: true, viewCount: 456000, videoCount: 42 }),
    'Public snapshot for "x": subscriber count hidden, 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: 0, hiddenSubscriberCount: false, viewCount: null, videoCount: null }),
    'Public snapshot for "x": ~0 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), view count unavailable, video count unavailable'
  );
});

// Phase 9 slice 9A -- proves the fix for the exact ambiguity independent review found: a null
// subscriberCount for a reason OTHER than YouTube hiding it (a genuinely absent/unparseable stat)
// must never be described as "hidden" (a specific, different, real fact).
test("AC-MI-12c: describePublicChannelSnapshot describes a null subscriberCount as 'unavailable', not 'hidden', when hiddenSubscriberCount is false", () => {
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: null, hiddenSubscriberCount: false, viewCount: 456000, videoCount: 42 }),
    'Public snapshot for "x": subscriber count unavailable, 456000 total views, 42 videos'
  );
});

// Found by independent review, round 2 (2026-09-26): an empty title (YouTube's own response
// omitted snippet.title -- the read gateway's `??` default is "") must never render as a
// confusing `for ""` with nothing identifying the channel.
test("AC-MI-12b: describePublicChannelSnapshot falls back to the channel id when title is empty", () => {
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "", subscriberCount: 100, hiddenSubscriberCount: false, viewCount: 200, videoCount: 3 }),
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
    publicSnapshot: { channelId: VALID_CHANNEL_ID, title: "Example", subscriberCount: null, hiddenSubscriberCount: true, viewCount: 9000, videoCount: 12 },
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
    publicSnapshot: { channelId: VALID_CHANNEL_ID, title: "Example", subscriberCount: null, hiddenSubscriberCount: false, viewCount: 9000, videoCount: 12 },
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
    publicSnapshot: { channelId: VALID_CHANNEL_ID, title: "Example", subscriberCount: 100, hiddenSubscriberCount: false, viewCount: 9000, videoCount: 12 },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  await services.fetchPublicSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(store.evidence.length, 1, "fetchPublicSnapshot's own free-text evidence row must exist as before");

  await services.captureChannelSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });

  assert.equal(store.evidence.length, 1, "captureChannelSnapshot must never write to research_evidence");
  assert.equal(store.channelSnapshots.length, 1, "captureChannelSnapshot writes exactly its own structured row");
});
