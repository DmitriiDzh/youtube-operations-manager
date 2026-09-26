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

function createFakeStore() {
  const channels = new Map<string, Row>();
  const evidence: EvidenceRow[] = [];
  let nextId = 1;

  return {
    channels,
    evidence,
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
          : { channelId: args.channelId, title: "Fetched Channel", subscriberCount: 100, viewCount: 200, videoCount: 3 };
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

test("AC-MI-10: fetchPublicSnapshot resolves credentials with YOUTUBE_READ_SCOPE, fetches by researchChannelId, and records a confirmed evidence row stamped from callOrigin", async () => {
  const { store, services, resolveCalls, snapshotCalls } = createFixture({
    publicSnapshot: { channelId: VALID_CHANNEL_ID, title: "Competitor", subscriberCount: 5000, viewCount: 90000, videoCount: 12 },
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
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: 12300, viewCount: 456000, videoCount: 42 }),
    'Public snapshot for "x": ~12300 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: null, viewCount: 456000, videoCount: 42 }),
    'Public snapshot for "x": subscriber count hidden, 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({ channelId: VALID_CHANNEL_ID, title: "x", subscriberCount: 0, viewCount: null, videoCount: null }),
    'Public snapshot for "x": ~0 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), view count unavailable, video count unavailable'
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
