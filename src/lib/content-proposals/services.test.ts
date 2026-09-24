import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createContentProposalServices } from "./services";

type FakeProposal = {
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

const WEB_UI_ORIGIN = { createdVia: "web_ui" as const, agentApiVersion: null };

function createFixture(
  overrides: Partial<{
    videosByChannel: Record<string, string[]>;
    assetsByChannel: Record<string, string[]>;
    idSequence: string[];
  }> = {}
) {
  const store = new Map<string, FakeProposal>();
  let idIndex = 0;
  const idSequence = overrides.idSequence ?? ["proposal-1", "proposal-2", "proposal-3"];

  const services = createContentProposalServices({
    idGenerator: () => idSequence[idIndex++] ?? `proposal-${idIndex}`,
    async insertProposal(input) {
      store.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        objective: input.objective,
        topicConcept: input.topicConcept,
        rationale: input.rationale,
        evidenceJson: input.evidenceJson,
        briefJson: input.briefJson,
        referenceVideoIdsJson: input.referenceVideoIdsJson,
        referenceAssetIdsJson: input.referenceAssetIdsJson,
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
        createdVia: input.createdVia,
        agentApiVersion: input.agentApiVersion,
      });
    },
    async listProposalsByChannel(channelId) {
      return [...store.values()].filter((p) => p.channelId === channelId);
    },
    async getProposalById(proposalId) {
      return store.get(proposalId) ?? null;
    },
    async videoBelongsToChannel(channelId, videoId) {
      return (overrides.videosByChannel?.[channelId] ?? []).includes(videoId);
    },
    async assetBelongsToChannel(channelId, assetId) {
      return (overrides.assetsByChannel?.[channelId] ?? []).includes(assetId);
    },
  });

  return { services, store };
}

// Owner spec §18: a created proposal round-trips with every field it was given.
test("createContentProposal persists and returns the full proposal record", async () => {
  const { services } = createFixture();

  const evidence = [
    {
      url: "https://example.com/report",
      retrievedAt: "2026-09-24T00:00:00.000Z",
      description: "Comparable-channel research",
      claimSupported: "This topic is trending",
      sourceType: "external_research" as const,
    },
  ];
  const brief = { proposedTitleDirection: "Something punchy", expectedMetrics: ["views", "retention"] };

  const result = await services.createContentProposal(
    {
      channelId: "UC_A",
      objective: "Grow subscribers",
      topicConcept: "Behind the scenes",
      rationale: "Audience keeps asking for this",
      evidence,
      brief,
    },
    WEB_UI_ORIGIN
  );

  assert.equal(result.proposalId, "proposal-1");
  assert.equal(result.channelId, "UC_A");
  assert.equal(result.objective, "Grow subscribers");
  assert.equal(result.topicConcept, "Behind the scenes");
  assert.equal(result.rationale, "Audience keeps asking for this");
  assert.deepEqual(result.evidence, evidence);
  assert.deepEqual(result.brief, brief);
  assert.equal(result.createdVia, "web_ui");
  assert.equal(result.agentApiVersion, null);
});

// Owner spec's own "never fabricate" discipline, already applied elsewhere in this codebase.
test("createContentProposal reports every optional field as null when omitted", async () => {
  const { services } = createFixture();

  const result = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  assert.equal(result.objective, null);
  assert.equal(result.topicConcept, null);
  assert.equal(result.rationale, null);
  assert.equal(result.evidence, null);
  assert.equal(result.brief, null);
  assert.equal(result.referenceVideoIds, null);
  assert.equal(result.referenceAssetIds, null);
});

// Phase 7 slice G (owner spec §22): identity is server-stamped via the separate `callOrigin`
// parameter, exactly like `ai-localization`'s `createChangeSetFromGeneration` (slice F).
test("createContentProposal stamps the caller's identity from callOrigin, never from input", async () => {
  const { services } = createFixture();

  const result = await services.createContentProposal({ channelId: "UC_A" }, { createdVia: "mcp", agentApiVersion: "0.6.0" });

  assert.equal(result.createdVia, "mcp");
  assert.equal(result.agentApiVersion, "0.6.0");
});

// AGENTS.md §F: a referenceVideoId that doesn't actually belong to the given channel must be
// rejected, not silently linked.
test("createContentProposal rejects a referenceVideoId that does not belong to the requested channel", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: ["vid1"] } });

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", referenceVideoIds: ["vid-from-elsewhere"] }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("createContentProposal accepts a referenceVideoId that does belong to the requested channel", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: ["vid1"] } });

  const result = await services.createContentProposal({ channelId: "UC_A", referenceVideoIds: ["vid1"] }, WEB_UI_ORIGIN);
  assert.deepEqual(result.referenceVideoIds, ["vid1"]);
});

// AGENTS.md §F: same check for referenceAssetIds, against asset-catalog's own channel scoping.
test("createContentProposal rejects a referenceAssetId that does not belong to the requested channel", async () => {
  const { services } = createFixture({ assetsByChannel: { UC_A: ["asset-x"] } });

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", referenceAssetIds: ["asset-from-elsewhere"] }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("createContentProposal accepts a referenceAssetId that does belong to the requested channel", async () => {
  const { services } = createFixture({ assetsByChannel: { UC_A: ["asset-x"] } });

  const result = await services.createContentProposal({ channelId: "UC_A", referenceAssetIds: ["asset-x"] }, WEB_UI_ORIGIN);
  assert.deepEqual(result.referenceAssetIds, ["asset-x"]);
});

test("createContentProposal rejects an unexpected input field as validation_failed", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", unexpectedField: "oops" }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// Phase 7 slice G (owner spec §22): createdVia/agentApiVersion must be an attestation, never a
// caller-suppliable input field -- same discipline as `ai-localization`'s own `.strict()` schema.
test("createContentProposal rejects a request body that tries to smuggle createdVia/agentApiVersion as input fields", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", createdVia: "mcp", agentApiVersion: "9.9.9" }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// listContentProposals scopes strictly by channelId.
test("listContentProposals returns only proposals for the requested channel", async () => {
  const { services } = createFixture({ idSequence: ["proposal-1", "proposal-2"] });
  await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);
  await services.createContentProposal({ channelId: "UC_B" }, WEB_UI_ORIGIN);

  const result = await services.listContentProposals({ channelId: "UC_A" });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].channelId, "UC_A");
});

// getContentProposal returns the full record for a proposal that belongs to the requesting
// channel.
test("getContentProposal returns the proposal when it belongs to the requesting channel", async () => {
  const { services } = createFixture();
  await services.createContentProposal({ channelId: "UC_A", objective: "Grow" }, WEB_UI_ORIGIN);

  const result = await services.getContentProposal({ channelId: "UC_A", proposalId: "proposal-1" });
  assert.equal(result.objective, "Grow");
});

// A nonexistent proposalId, and one belonging to a DIFFERENT channel, must both fail the same
// way (CONTENT_PROPOSAL_NOT_AVAILABLE) -- never distinguishable, same discipline as
// `getAssetContext`.
test("getContentProposal throws CONTENT_PROPOSAL_NOT_AVAILABLE for a nonexistent proposalId", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getContentProposal({ channelId: "UC_A", proposalId: "does-not-exist" }),
    (error: unknown) => error instanceof DomainError && error.code === "CONTENT_PROPOSAL_NOT_AVAILABLE"
  );
});

test("getContentProposal throws CONTENT_PROPOSAL_NOT_AVAILABLE for a proposalId that belongs to a different channel", async () => {
  const { services } = createFixture();
  await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  await assert.rejects(
    () => services.getContentProposal({ channelId: "UC_B", proposalId: "proposal-1" }),
    (error: unknown) => error instanceof DomainError && error.code === "CONTENT_PROPOSAL_NOT_AVAILABLE"
  );
});

// A stored evidence/brief value that isn't valid JSON is reported as null, never crashes the
// read (same discipline `asset-catalog`'s own `getAssetContext` already applies).
test("getContentProposal reports evidence/brief as null, not a crash, when the stored JSON is malformed", async () => {
  const services = createContentProposalServices({
    idGenerator: () => "proposal-1",
    async insertProposal() {},
    async listProposalsByChannel() {
      return [];
    },
    async getProposalById() {
      return {
        id: "proposal-1",
        channelId: "UC_A",
        objective: null,
        topicConcept: null,
        rationale: null,
        evidenceJson: "{not valid json",
        briefJson: "[not an object]",
        referenceVideoIdsJson: null,
        referenceAssetIdsJson: null,
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
        createdVia: "web_ui",
        agentApiVersion: null,
      };
    },
    async videoBelongsToChannel() {
      return false;
    },
    async assetBelongsToChannel() {
      return false;
    },
  });

  const result = await services.getContentProposal({ channelId: "UC_A", proposalId: "proposal-1" });
  assert.equal(result.evidence, null);
  assert.equal(result.brief, null);
});
