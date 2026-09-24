import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { DomainError } from "./contracts";
import { createContentProposalCore } from "./index";

const WEB_UI_ORIGIN = { createdVia: "web_ui" as const, agentApiVersion: null };

// Wiring test -- uses the REAL store adapter/db, unlike services.test.ts's injected fakes.
// Proves `videoBelongsToChannel` genuinely reaches the real, already-synced channel/video mirror
// (reused from `changesets`, AGENTS.md §D) rather than a stub that always agrees.
test("createContentProposalCore.createContentProposal rejects a referenceVideoId that does not belong to a real, freshly-synced channel with no videos", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  await assert.rejects(
    () =>
      core.createContentProposal(
        { channelId, referenceVideoIds: ["a-video-id-that-does-not-exist"] },
        WEB_UI_ORIGIN
      ),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("createContentProposalCore round-trips a real create/list/get against the real database", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 2",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const created = await core.createContentProposal({ channelId, objective: "Grow the channel" }, WEB_UI_ORIGIN);

  const listed = await core.listContentProposals({ channelId });
  assert.deepEqual(
    listed.proposals.map((p) => p.proposalId),
    [created.proposalId]
  );

  const fetched = await core.getContentProposal({ channelId, proposalId: created.proposalId });
  assert.equal(fetched.objective, "Grow the channel");
});

// Exercises a SUCCESSFUL link against a real, channel-owned video end to end.
test("createContentProposalCore.createContentProposal accepts and persists a referenceVideoId that genuinely belongs to the requested channel", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;
  const videoId = `vid_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 3",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });
  await upsertVideos(
    [
      {
        videoId,
        channelId,
        title: "Test video",
        description: "",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        etag: null,
      },
    ],
    new Date()
  );

  const created = await core.createContentProposal({ channelId, referenceVideoIds: [videoId] }, WEB_UI_ORIGIN);
  assert.deepEqual(created.referenceVideoIds, [videoId]);
});

// Same real-wiring proof for referenceAssetIds, against the REAL asset-catalog module (AGENTS.md
// §D -- never a second, parallel asset-ownership check).
test("createContentProposalCore.createContentProposal rejects a referenceAssetId that does not belong to the requested channel", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 4",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  await assert.rejects(
    () => core.createContentProposal({ channelId, referenceAssetIds: ["an-asset-id-that-does-not-exist"] }, WEB_UI_ORIGIN),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("createContentProposalCore.createContentProposal accepts and persists a referenceAssetId that genuinely belongs to the requested channel", async () => {
  const core = createContentProposalCore();
  const assetCatalog = createAssetCatalogCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 5",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const asset = await assetCatalog.registerAsset({
    channelId,
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "https://example.com/thumb.png",
  });

  const created = await core.createContentProposal({ channelId, referenceAssetIds: [asset.assetId] }, WEB_UI_ORIGIN);
  assert.deepEqual(created.referenceAssetIds, [asset.assetId]);
});

// Wiring test for slice G2 (owner spec §19) -- real database, real asset-catalog core, proving
// the two modules genuinely connect end to end, not just against injected fakes.
test("createContentProposalCore.registerExternalArtifact registers a real asset and links it, round-trips through listProposalArtifacts", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 6",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const proposal = await core.createContentProposal({ channelId }, WEB_UI_ORIGIN);

  const link = await core.registerExternalArtifact(
    {
      channelId,
      proposalId: proposal.proposalId,
      assetType: "thumbnail",
      referenceKind: "url",
      referenceValue: "https://example.com/real-thumb.png",
    },
    { createdVia: "mcp", agentApiVersion: "0.6.0" }
  );

  assert.equal(link.asset.referenceValue, "https://example.com/real-thumb.png");
  assert.equal(link.createdVia, "mcp");

  const listed = await core.listProposalArtifacts({ channelId, proposalId: proposal.proposalId });
  assert.equal(listed.artifacts.length, 1);
  assert.equal(listed.artifacts[0].asset.referenceValue, "https://example.com/real-thumb.png");
});

test("createContentProposalCore.registerExternalArtifact rejects a proposalId that does not belong to the requested channel", async () => {
  const core = createContentProposalCore();
  const channelId = `UC_TEST_${randomUUID()}`;
  const otherChannelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Content proposal wiring test channel 7",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });
  await upsertChannel({
    channelId: otherChannelId,
    title: "Content proposal wiring test channel 8",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const proposal = await core.createContentProposal({ channelId }, WEB_UI_ORIGIN);

  await assert.rejects(
    () =>
      core.registerExternalArtifact(
        {
          channelId: otherChannelId,
          proposalId: proposal.proposalId,
          assetType: "thumbnail",
          referenceKind: "url",
          referenceValue: "https://example.com/real-thumb.png",
        },
        WEB_UI_ORIGIN
      ),
    (error: unknown) => error instanceof DomainError && error.code === "CONTENT_PROPOSAL_NOT_AVAILABLE"
  );
});
