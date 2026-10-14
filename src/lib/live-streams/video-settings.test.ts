import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DomainError } from "./contracts";
import type { StoredStreamRow } from "./services";
import { createStreamVideoSettings, readStoredVideoSettings, type ThumbnailStore } from "./video-settings";

// BL-186 acceptance (LIVE_STREAMS_FIELDS_PLAN.md §4.1 "Settings"): saving writes nothing to YouTube (the module has no YouTube
// dependency at all); an invalid value -- tags over 500 characters as YouTube counts them, an unknown category, a language not in
// the app's list, a thumbnail over 2 MB or not JPEG/PNG by its bytes -- is refused and nothing is stored. Limits from the YouTube
// Data API videos resource and thumbnails.set; expected values written by hand.

const NOW = new Date("2026-10-14T12:00:00.000Z");
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function image(head: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return bytes;
}

function harness(initial: Partial<StoredStreamRow> | null = { videoSettingsJson: null }) {
  let row: StoredStreamRow | null = initial
    ? ({ channelId: "UC1", intent: "off", streamId: null, broadcastId: null, title: "Radio", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence", passNumber: 0, passOrderJson: null, nextPassOrderJson: null, positionIndex: 0, positionOffsetSeconds: 0, positionUpdatedAt: null, onSince: null, createdAt: NOW, updatedAt: NOW, ...initial } as StoredStreamRow)
    : null;
  const events: Array<{ kind: string; detail: unknown }> = [];
  const files = new Map<string, { kind: "jpeg" | "png"; bytes: Uint8Array }>();
  const thumbnails: ThumbnailStore = {
    write: async (channelId, kind, bytes) => void files.set(channelId, { kind, bytes }),
    read: async (channelId) => files.get(channelId) ?? null,
    remove: async (channelId) => void files.delete(channelId),
  };
  let id = 0;
  const core = createStreamVideoSettings({
    store: {
      getStream: async () => row,
      updateStream: async (_c, set) => {
        if (!row) return false;
        row = { ...row, ...set };
        return true;
      },
      upsertStream: async (next) => {
        row = { positionUpdatedAt: null, onSince: null, passOrderJson: null, nextPassOrderJson: null, streamId: null, broadcastId: null, ...next } as StoredStreamRow;
      },
      insertEvent: async (e) => void events.push({ kind: e.kind, detail: JSON.parse(e.detailJson) }),
    },
    thumbnails,
    clock: () => NOW,
    newId: () => `e${++id}`,
  });
  return { core, row: () => row, events, files };
}

const VALID = {
  tags: ["jazz", "lofi radio"],
  categoryId: "10",
  defaultLanguage: "en",
  defaultAudioLanguage: "zxx",
  license: "creativeCommon",
  publicStatsViewable: false,
  containsSyntheticMedia: true,
  paidProductPlacement: true,
  recordingDate: "2026-10-14T00:00:00.000Z",
  playlists: [{ id: "PL0123456789abcdefghijklmnopqrstuv", title: "Radio" }],
  broadcast: { latencyPreference: "ultraLow", enableDvr: false, enableEmbed: false, closedCaptionsType: "closedCaptionsDisabled" },
};

test("save: the whole form is stored as v1 with no thumbnail, and an event records it", async () => {
  const h = harness();
  await h.core.save("UC1", VALID);
  assert.deepEqual(JSON.parse(h.row()!.videoSettingsJson!), { v: 1, ...VALID, thumbnail: null });
  assert.deepEqual(h.events.map((e) => e.kind), ["video_settings_saved"]);
  assert.deepEqual(readStoredVideoSettings(h.row()!.videoSettingsJson), { ok: true, settings: { v: 1, ...VALID, thumbnail: null } });
});

test("save: a channel with no stream row yet gets one (default texts) holding the settings", async () => {
  const h = harness(null);
  await h.core.save("UC1", VALID);
  assert.equal(h.row()?.title, "");
  assert.equal(h.row()?.intent, "off");
  assert.equal(JSON.parse(h.row()!.videoSettingsJson!).categoryId, "10");
});

test("tags: exactly 500 characters as YouTube counts them pass, 501 are refused", async () => {
  // 100+100+100+100+96 characters and 4 commas = 500.
  const at = ["a", "b", "c", "d"].map((c) => c.repeat(100)).concat(["e".repeat(96)]);
  await harness().core.save("UC1", { ...VALID, tags: at });
  const over = harness();
  await assert.rejects(over.core.save("UC1", { ...VALID, tags: [...at.slice(0, 4), "e".repeat(97)] }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(over.row()!.videoSettingsJson, null);
  // A tag with a space counts its two quotes: 100*4 + 96 ("x"*94 + " y") + 2 quotes + 4 commas = 502 -- refused, though the
  // characters alone would make exactly 500.
  const quoted = harness();
  await assert.rejects(quoted.core.save("UC1", { ...VALID, tags: [...at.slice(0, 4), "x".repeat(94) + " y"] }), (e: unknown) => e instanceof DomainError);
});

test("refused before anything is stored: each invalid value", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["duplicate tag (case-insensitive)", { tags: ["Jazz", "jazz"] }],
    ["tag with a comma", { tags: ["jazz,lofi"] }],
    ["tag with an angle bracket", { tags: ["<jazz>"] }],
    ["tag of 101 characters", { tags: ["x".repeat(101)] }],
    ["unknown category", { categoryId: "99" }],
    ["language not in the app's list", { defaultLanguage: "xx" }],
    ["zxx is an audio value only", { defaultLanguage: "zxx" }],
    ["unknown license", { license: "public" }],
    ["unknown latency", { broadcast: { ...VALID.broadcast, latencyPreference: "fast" } }],
    ["captions other than off (owner, plan Q2)", { broadcast: { ...VALID.broadcast, closedCaptionsType: "closedCaptionsHttpPost" } }],
    ["recording date not at midnight UTC", { recordingDate: "2026-10-14" }],
    ["recording date that does not exist", { recordingDate: "2026-02-30T00:00:00.000Z" }],
    ["eleven playlists", { playlists: Array.from({ length: 11 }, (_, i) => ({ id: `PL${String(i).padStart(32, "0")}`, title: "p" })) }],
    ["the same playlist twice", { playlists: [VALID.playlists[0], VALID.playlists[0]] }],
    ["a playlist id with a slash", { playlists: [{ id: "PL/../x", title: "p" }] }],
    ["an unknown field", { notifySubscribers: true }],
    ["a thumbnail sent in the form", { thumbnail: { kind: "jpeg", bytes: 1, sha256: "0".repeat(64), savedAt: "x" } }],
  ];
  for (const [name, change] of cases) {
    const h = harness();
    await assert.rejects(h.core.save("UC1", { ...VALID, ...change }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed", name);
    assert.equal(h.row()!.videoSettingsJson, null, name);
    assert.deepEqual(h.events, [], name);
  }
});

test("thumbnail: a JPEG of exactly 2 MB is kept with its SHA-256; saving the form afterwards keeps it", async () => {
  const h = harness();
  const bytes = image(JPEG_HEAD, 2 * 1024 * 1024);
  const saved = await h.core.setThumbnail("UC1", bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(saved, { kind: "jpeg", bytes: 2 * 1024 * 1024, sha256, savedAt: NOW.toISOString() });
  assert.equal(h.files.get("UC1")?.kind, "jpeg");
  await h.core.save("UC1", VALID);
  assert.deepEqual(JSON.parse(h.row()!.videoSettingsJson!).thumbnail, saved);
  assert.deepEqual(await h.core.readThumbnail("UC1"), { kind: "jpeg", bytes });
});

test("thumbnail: over 2 MB, empty, or not JPEG/PNG by its bytes is refused and nothing is written", async () => {
  for (const [name, bytes] of [
    ["2 MB + 1 byte", image(JPEG_HEAD, 2 * 1024 * 1024 + 1)],
    ["empty", new Uint8Array()],
    ["a GIF", image([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 100)],
    ["a WebP", image([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0], 100)],
  ] as const) {
    const h = harness();
    await assert.rejects(h.core.setThumbnail("UC1", bytes), (e: unknown) => e instanceof DomainError && e.code === "validation_failed", name);
    assert.equal(h.files.size, 0, name);
    assert.equal(h.row()!.videoSettingsJson, null, name);
  }
});

test("thumbnail: a PNG is accepted; removing it clears the settings' thumbnail; a file changed on disk is not served", async () => {
  const h = harness();
  await h.core.setThumbnail("UC1", image(PNG_HEAD, 500));
  h.files.set("UC1", { kind: "png", bytes: image(PNG_HEAD, 501) });
  assert.equal(await h.core.readThumbnail("UC1"), null, "the bytes no longer match the saved hash");
  await h.core.clearThumbnail("UC1");
  assert.equal(h.files.size, 0);
  assert.equal(JSON.parse(h.row()!.videoSettingsJson!).thumbnail, null);
  assert.deepEqual(h.events.map((e) => e.kind), ["thumbnail_saved", "thumbnail_removed"]);
});

test("a corrupt stored value is reported, never read as defaults; re-saving the form replaces it", async () => {
  const h = harness({ videoSettingsJson: '{"v":1,"tags":"oops"}' });
  const read = await h.core.get("UC1");
  assert.equal(read.ok, false);
  await assert.rejects(h.core.setThumbnail("UC1", image(JPEG_HEAD, 10)), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await h.core.save("UC1", VALID);
  assert.deepEqual((await h.core.get("UC1")).ok, true);
});
