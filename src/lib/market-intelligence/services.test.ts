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
import { createMarketIntelligenceServices } from "./services";
import { isDomainError } from "./contracts";

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

function createFixture() {
  const store = createFakeStore();
  const services = createMarketIntelligenceServices(store);
  return { store, services };
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
