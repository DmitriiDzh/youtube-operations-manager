import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { DomainError } from "./contracts";
import { createAssetCatalogCore } from "./index";

// Wiring test -- uses the REAL store adapter/db, unlike services.test.ts's injected fakes.
// Proves `videoBelongsToChannel` genuinely reaches the real, already-synced channel/video mirror
// (reused from `changesets`, AGENTS.md §D) rather than a stub that always agrees.
test("createAssetCatalogCore.registerAsset rejects a linkedVideoId that does not belong to a real, freshly-synced channel with no videos", async () => {
  const core = createAssetCatalogCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Asset catalog wiring test channel",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  await assert.rejects(
    () =>
      core.registerAsset({
        channelId,
        assetType: "thumbnail",
        referenceKind: "url",
        referenceValue: "https://example.com/thumb.png",
        linkedVideoId: "a-video-id-that-does-not-exist",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("createAssetCatalogCore round-trips a real register/list/get against the real database", async () => {
  const core = createAssetCatalogCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Asset catalog wiring test channel 2",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const registered = await core.registerAsset({
    channelId,
    assetType: "script",
    referenceKind: "external_artifact_id",
    referenceValue: "artifact-abc",
  });

  const listed = await core.listAssets({ channelId });
  assert.deepEqual(
    listed.assets.map((a) => a.assetId),
    [registered.assetId]
  );

  const fetched = await core.getAssetContext({ channelId, assetId: registered.assetId });
  assert.equal(fetched.referenceValue, "artifact-abc");
});

// The two tests above cover a rejected linkedVideoId and a register/list/get round-trip with
// none -- this one exercises a SUCCESSFUL link against a real, channel-owned video end to end.
test("createAssetCatalogCore.registerAsset accepts and persists a linkedVideoId that genuinely belongs to the requested channel", async () => {
  const core = createAssetCatalogCore();
  const channelId = `UC_TEST_${randomUUID()}`;
  const videoId = `vid_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Asset catalog wiring test channel 3",
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

  const registered = await core.registerAsset({
    channelId,
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "https://example.com/thumb.png",
    linkedVideoId: videoId,
  });

  assert.equal(registered.linkedVideoId, videoId);

  const fetched = await core.getAssetContext({ channelId, assetId: registered.assetId });
  assert.equal(fetched.linkedVideoId, videoId);

  const byVideo = await core.listAssets({ channelId, videoId });
  assert.deepEqual(
    byVideo.assets.map((a) => a.assetId),
    [registered.assetId]
  );
});
