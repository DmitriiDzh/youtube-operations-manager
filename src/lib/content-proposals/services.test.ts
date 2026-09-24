import assert from "node:assert/strict";
import test from "node:test";
import type { CreativeAsset } from "@/lib/asset-catalog";
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

type FakeCreativeAsset = CreativeAsset;

type FakeArtifactLink = {
  id: string;
  proposalId: string;
  assetId: string;
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
    assetIdSequence: string[];
    linkIdSequence: string[];
  }> = {}
) {
  const store = new Map<string, FakeProposal>();
  const assetStore = new Map<string, FakeCreativeAsset>();
  const linkStore = new Map<string, FakeArtifactLink>();
  let idIndex = 0;
  let assetIdIndex = 0;
  let linkIdIndex = 0;
  const idSequence = overrides.idSequence ?? ["proposal-1", "proposal-2", "proposal-3"];
  const assetIdSequence = overrides.assetIdSequence ?? ["asset-1", "asset-2", "asset-3"];
  const linkIdSequence = overrides.linkIdSequence ?? ["link-1", "link-2", "link-3"];

  const services = createContentProposalServices({
    idGenerator: () => {
      // Shared id generator across proposals/links, same as the real (single) `randomUUID`
      // generator this module's real store adapter uses -- distinguished here only by which
      // sequence has entries left, mirroring how a real UUID generator can't tell callers apart.
      const next = idSequence[idIndex] ?? linkIdSequence[linkIdIndex];
      if (idIndex < idSequence.length) {
        idIndex++;
        return next ?? `proposal-${idIndex}`;
      }
      return linkIdSequence[linkIdIndex++] ?? `link-${linkIdIndex}`;
    },
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
    async registerAsset(input) {
      const assetId = assetIdSequence[assetIdIndex++] ?? `asset-${assetIdIndex}`;
      const asset = {
        assetId,
        channelId: input.channelId,
        assetType: input.assetType,
        referenceKind: input.referenceKind,
        referenceValue: input.referenceValue,
        title: input.title ?? null,
        description: input.description ?? null,
        linkedVideoId: input.linkedVideoId ?? null,
        provenance: input.provenance ?? null,
        createdAt: "2026-09-24T00:00:00.000Z",
      } as FakeCreativeAsset;
      assetStore.set(assetId, asset);
      return asset;
    },
    async insertArtifactLink(input) {
      linkStore.set(input.id, {
        id: input.id,
        proposalId: input.proposalId,
        assetId: input.assetId,
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
        createdVia: input.createdVia,
        agentApiVersion: input.agentApiVersion ?? null,
      });
    },
    async getArtifactLinkById(linkId) {
      return linkStore.get(linkId) ?? null;
    },
    async listArtifactLinksByProposal(proposalId) {
      return [...linkStore.values()].filter((l) => l.proposalId === proposalId);
    },
    async getAssetById(channelId, assetId) {
      const asset = assetStore.get(assetId);
      return asset && asset.channelId === channelId ? asset : null;
    },
  });

  return { services, store, assetStore, linkStore };
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

// `brief` is a `.strict()`-validated object with named, bounded keys, deliberately never an open
// `z.record` (contracts.ts's own doc comment: "never persist arbitrary unbounded content").
test("createContentProposal rejects a brief with an unrecognized key", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", brief: { proposedTitleDirection: "x", unexpectedKey: "oops" } }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("createContentProposal rejects a brief field longer than its bound", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.createContentProposal({ channelId: "UC_A", brief: { proposedTitleDirection: "x".repeat(2001) } }, WEB_UI_ORIGIN),
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
    async registerAsset() {
      throw new Error("not used");
    },
    async insertArtifactLink() {},
    async getArtifactLinkById() {
      return null;
    },
    async listArtifactLinksByProposal() {
      return [];
    },
    async getAssetById() {
      return null;
    },
  });

  const result = await services.getContentProposal({ channelId: "UC_A", proposalId: "proposal-1" });
  assert.equal(result.evidence, null);
  assert.equal(result.brief, null);
});

// Owner spec §19: registers an externally-produced artifact and links it back to the proposal.
test("registerExternalArtifact registers the asset via asset-catalog and links it to the proposal", async () => {
  const { services, assetStore, linkStore } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  const result = await services.registerExternalArtifact(
    {
      channelId: "UC_A",
      proposalId: proposal.proposalId,
      assetType: "thumbnail",
      referenceKind: "url",
      referenceValue: "https://example.com/thumb.png",
    },
    { createdVia: "mcp", agentApiVersion: "0.6.0" }
  );

  assert.equal(result.proposalId, proposal.proposalId);
  assert.equal(result.channelId, "UC_A");
  assert.equal(result.asset.referenceValue, "https://example.com/thumb.png");
  assert.equal(result.createdVia, "mcp");
  assert.equal(result.agentApiVersion, "0.6.0");
  assert.equal(assetStore.size, 1);
  assert.equal(linkStore.size, 1);
});

// Owner spec §17: agent-callable registration must never accept `local_path` -- that stays
// operator-only via the pre-existing `asset register` CLI command.
test("registerExternalArtifact rejects referenceKind local_path as validation_failed", async () => {
  const { services, assetStore, linkStore } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  await assert.rejects(
    () =>
      services.registerExternalArtifact(
        {
          channelId: "UC_A",
          proposalId: proposal.proposalId,
          assetType: "thumbnail",
          referenceKind: "local_path",
          referenceValue: "/tmp/x.png",
        },
        WEB_UI_ORIGIN
      ),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
  // The schema rejection must happen before any write -- no asset or link row is created for a
  // rejected `local_path` attempt (owner spec §17's restriction is not merely cosmetic).
  assert.equal(assetStore.size, 0);
  assert.equal(linkStore.size, 0);
});

test("registerExternalArtifact throws CONTENT_PROPOSAL_NOT_AVAILABLE for a proposalId that belongs to a different channel", async () => {
  const { services } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  await assert.rejects(
    () =>
      services.registerExternalArtifact(
        {
          channelId: "UC_B",
          proposalId: proposal.proposalId,
          assetType: "thumbnail",
          referenceKind: "url",
          referenceValue: "https://example.com/thumb.png",
        },
        WEB_UI_ORIGIN
      ),
    (error: unknown) => error instanceof DomainError && error.code === "CONTENT_PROPOSAL_NOT_AVAILABLE"
  );
});

// callOrigin must be an attestation, never a caller-suppliable input field.
test("registerExternalArtifact rejects a request body that tries to smuggle createdVia/agentApiVersion as input fields", async () => {
  const { services } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  await assert.rejects(
    () =>
      services.registerExternalArtifact(
        {
          channelId: "UC_A",
          proposalId: proposal.proposalId,
          assetType: "thumbnail",
          referenceKind: "url",
          referenceValue: "https://example.com/thumb.png",
          createdVia: "mcp",
        },
        WEB_UI_ORIGIN
      ),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("listProposalArtifacts returns every artifact registered against the proposal", async () => {
  const { services } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);
  await services.registerExternalArtifact(
    { channelId: "UC_A", proposalId: proposal.proposalId, assetType: "thumbnail", referenceKind: "url", referenceValue: "a" },
    WEB_UI_ORIGIN
  );
  await services.registerExternalArtifact(
    { channelId: "UC_A", proposalId: proposal.proposalId, assetType: "script", referenceKind: "external_artifact_id", referenceValue: "artifact-1" },
    WEB_UI_ORIGIN
  );

  const result = await services.listProposalArtifacts({ channelId: "UC_A", proposalId: proposal.proposalId });
  assert.equal(result.artifacts.length, 2);
  assert.deepEqual(
    result.artifacts.map((a) => a.asset.referenceValue).sort(),
    ["a", "artifact-1"]
  );
});

test("listProposalArtifacts throws CONTENT_PROPOSAL_NOT_AVAILABLE for a proposalId that belongs to a different channel", async () => {
  const { services } = createFixture();
  const proposal = await services.createContentProposal({ channelId: "UC_A" }, WEB_UI_ORIGIN);

  await assert.rejects(
    () => services.listProposalArtifacts({ channelId: "UC_B", proposalId: proposal.proposalId }),
    (error: unknown) => error instanceof DomainError && error.code === "CONTENT_PROPOSAL_NOT_AVAILABLE"
  );
});
