import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createAssetCatalogServices } from "./services";

type FakeAsset = {
  id: string;
  channelId: string;
  assetType: string;
  referenceKind: string;
  referenceValue: string;
  title: string | null;
  description: string | null;
  linkedVideoId: string | null;
  provenanceJson: string | null;
  createdAt: Date;
};

function createFixture(
  overrides: Partial<{
    videosByChannel: Record<string, string[]>;
    idSequence: string[];
  }> = {}
) {
  const store = new Map<string, FakeAsset>();
  let idIndex = 0;
  const idSequence = overrides.idSequence ?? ["asset-1", "asset-2", "asset-3"];

  const services = createAssetCatalogServices({
    idGenerator: () => idSequence[idIndex++] ?? `asset-${idIndex}`,
    async insertAsset(input) {
      store.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        assetType: input.assetType,
        referenceKind: input.referenceKind,
        referenceValue: input.referenceValue,
        title: input.title ?? null,
        description: input.description ?? null,
        linkedVideoId: input.linkedVideoId ?? null,
        provenanceJson: input.provenanceJson ?? null,
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
      });
    },
    async listAssetsByChannel(channelId, filters) {
      return [...store.values()].filter((asset) => {
        if (asset.channelId !== channelId) return false;
        if (filters.videoId && asset.linkedVideoId !== filters.videoId) return false;
        if (filters.assetType && asset.assetType !== filters.assetType) return false;
        return true;
      });
    },
    async getAssetById(assetId) {
      return store.get(assetId) ?? null;
    },
    async videoBelongsToChannel(channelId, videoId) {
      return (overrides.videosByChannel?.[channelId] ?? []).includes(videoId);
    },
  });

  return { services, store };
}

// AC-ASSET-01 (owner spec §15): a registered asset round-trips with every field it was given.
test("registerAsset persists and returns the full asset record, including provenance", async () => {
  const { services } = createFixture();

  const result = await services.registerAsset({
    channelId: "UC_A",
    assetType: "thumbnail",
    referenceKind: "local_path",
    referenceValue: "/tmp/cover.png",
    title: "Cover v1",
    description: "First draft cover",
    provenance: { tool: "midjourney", prompt: "a jazz club at night" },
  });

  assert.equal(result.assetId, "asset-1");
  assert.equal(result.channelId, "UC_A");
  assert.equal(result.assetType, "thumbnail");
  assert.equal(result.referenceKind, "local_path");
  assert.equal(result.referenceValue, "/tmp/cover.png");
  assert.equal(result.title, "Cover v1");
  assert.deepEqual(result.provenance, { tool: "midjourney", prompt: "a jazz club at night" });
});

// AC-ASSET-02: title/description/linkedVideoId/provenance are `null` when omitted, never a
// fabricated default (owner spec's own "never fabricate" discipline, already applied elsewhere
// in this codebase to lastSyncedAt/editorialProfile).
test("registerAsset reports title/description/linkedVideoId/provenance as null when omitted", async () => {
  const { services } = createFixture();

  const result = await services.registerAsset({
    channelId: "UC_A",
    assetType: "script",
    referenceKind: "url",
    referenceValue: "https://example.com/script.txt",
  });

  assert.equal(result.title, null);
  assert.equal(result.description, null);
  assert.equal(result.linkedVideoId, null);
  assert.equal(result.provenance, null);
});

// AC-ASSET-03 (AGENTS.md §F): a linkedVideoId that doesn't actually belong to the given channel
// must be rejected, not silently linked.
test("registerAsset rejects a linkedVideoId that does not belong to the requested channel", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: ["vid1"] } });

  await assert.rejects(
    () =>
      services.registerAsset({
        channelId: "UC_A",
        assetType: "thumbnail",
        referenceKind: "local_path",
        referenceValue: "/tmp/x.png",
        linkedVideoId: "vid-from-another-channel",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("registerAsset accepts a linkedVideoId that does belong to the requested channel", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: ["vid1"] } });

  const result = await services.registerAsset({
    channelId: "UC_A",
    assetType: "thumbnail",
    referenceKind: "local_path",
    referenceValue: "/tmp/x.png",
    linkedVideoId: "vid1",
  });

  assert.equal(result.linkedVideoId, "vid1");
});

// AC-ASSET-04: listAssets scopes strictly by channelId -- an asset from another channel is never
// returned, even if the request has no other filter.
test("listAssets returns only assets for the requested channel", async () => {
  const { services } = createFixture({ idSequence: ["asset-1", "asset-2"] });
  await services.registerAsset({ channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "a" });
  await services.registerAsset({ channelId: "UC_B", assetType: "thumbnail", referenceKind: "url", referenceValue: "b" });

  const result = await services.listAssets({ channelId: "UC_A" });

  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].channelId, "UC_A");
});

// AC-ASSET-05: optional videoId/assetType filters narrow the result.
test("listAssets narrows by videoId and assetType filters", async () => {
  const { services } = createFixture({
    videosByChannel: { UC_A: ["vid1", "vid2"] },
    idSequence: ["asset-1", "asset-2", "asset-3"],
  });
  await services.registerAsset({ channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "a", linkedVideoId: "vid1" });
  await services.registerAsset({ channelId: "UC_A", assetType: "script", referenceKind: "url", referenceValue: "b", linkedVideoId: "vid2" });
  await services.registerAsset({ channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "c", linkedVideoId: "vid2" });

  const byVideo = await services.listAssets({ channelId: "UC_A", videoId: "vid2" });
  assert.deepEqual(byVideo.assets.map((a) => a.assetId).sort(), ["asset-2", "asset-3"]);

  const byType = await services.listAssets({ channelId: "UC_A", assetType: "thumbnail" });
  assert.deepEqual(byType.assets.map((a) => a.assetId).sort(), ["asset-1", "asset-3"]);
});

// AC-ASSET-06: getAssetContext returns the full record for an asset that belongs to the
// requesting channel.
test("getAssetContext returns the asset when it belongs to the requesting channel", async () => {
  const { services } = createFixture();
  await services.registerAsset({ channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "a" });

  const result = await services.getAssetContext({ channelId: "UC_A", assetId: "asset-1" });
  assert.equal(result.assetId, "asset-1");
});

// AC-ASSET-07: a nonexistent assetId, and an assetId that belongs to a DIFFERENT channel, must
// both fail the same way (ASSET_NOT_AVAILABLE) -- never distinguishable, so a caller can't probe
// which asset ids exist for a channel it has no access to.
test("getAssetContext throws ASSET_NOT_AVAILABLE for a nonexistent assetId", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getAssetContext({ channelId: "UC_A", assetId: "does-not-exist" }),
    (error: unknown) => error instanceof DomainError && error.code === "ASSET_NOT_AVAILABLE"
  );
});

test("getAssetContext throws ASSET_NOT_AVAILABLE for an assetId that belongs to a different channel", async () => {
  const { services } = createFixture();
  await services.registerAsset({ channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "a" });

  await assert.rejects(
    () => services.getAssetContext({ channelId: "UC_B", assetId: "asset-1" }),
    (error: unknown) => error instanceof DomainError && error.code === "ASSET_NOT_AVAILABLE"
  );
});

// AC-ASSET-08: a stored provenance value that isn't valid JSON is reported as null, never
// crashes the read (same discipline `listAnalyticsCollectionRunsByChannel` already applies to
// its own JSON column).
test("getAssetContext reports provenance as null, not a crash, when the stored JSON is malformed", async () => {
  const services = createAssetCatalogServices({
    idGenerator: () => "asset-1",
    async insertAsset() {},
    async listAssetsByChannel() {
      return [];
    },
    async getAssetById() {
      return {
        id: "asset-1",
        channelId: "UC_A",
        assetType: "thumbnail",
        referenceKind: "url",
        referenceValue: "a",
        title: null,
        description: null,
        linkedVideoId: null,
        provenanceJson: "{not valid json",
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
      };
    },
    async videoBelongsToChannel() {
      return false;
    },
  });

  const result = await services.getAssetContext({ channelId: "UC_A", assetId: "asset-1" });
  assert.equal(result.provenance, null);
});

test("registerAsset rejects an unexpected input field as validation_failed", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.registerAsset({
        channelId: "UC_A",
        assetType: "thumbnail",
        referenceKind: "url",
        referenceValue: "a",
        unexpectedField: "oops",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});
