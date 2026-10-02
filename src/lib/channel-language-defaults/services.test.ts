import assert from "node:assert/strict";
import test from "node:test";
import { createChannelLanguageDefaultsServices } from "./services";
import type { ChannelLanguageDefaults, StoredVideoLanguageRow } from "./contracts";

// Expected values below are stated by hand from the owner's requirement (2026-10-02): a video
// deviates when its language differs from the chosen baseline; an unset baseline compares nothing.

function makeServices(args: { videos: StoredVideoLanguageRow[]; defaults?: ChannelLanguageDefaults; channelExists?: boolean }) {
  let defaults: ChannelLanguageDefaults = args.defaults ?? { defaultLanguage: null, defaultAudioLanguage: null };
  const services = createChannelLanguageDefaultsServices({
    store: {
      getChannel: async (channelId) => (args.channelExists === false ? null : { channelId }),
      getDefaults: async () => defaults,
      setDefaults: async (_id, value) => {
        defaults = value;
      },
      listVideos: async () => args.videos,
    },
  });
  return { services, getStored: () => defaults };
}

const videos: StoredVideoLanguageRow[] = [
  { videoId: "a", title: "A", defaultLanguage: "en", defaultAudioLanguage: "zxx" },
  { videoId: "b", title: "B", defaultLanguage: null, defaultAudioLanguage: "zxx" },
  { videoId: "c", title: "C", defaultLanguage: "ja", defaultAudioLanguage: "en" },
  { videoId: "d", title: "D", defaultLanguage: "en", defaultAudioLanguage: null },
];

test("no baseline chosen: nothing deviates", async () => {
  const { services } = makeServices({ videos });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.deepEqual(report.deviations, []);
  assert.equal(report.totalVideos, 4);
});

test("baseline en / zxx: b (missing language), c (both) and d (missing audio) deviate; a does not", async () => {
  const { services } = makeServices({ videos, defaults: { defaultLanguage: "en", defaultAudioLanguage: "zxx" } });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.deepEqual(
    report.deviations.map((d) => [d.videoId, d.defaultLanguageDeviates, d.defaultAudioLanguageDeviates]),
    [
      ["b", true, false],
      ["c", true, true],
      ["d", false, true],
    ]
  );
});

test("only the audio baseline set: the language field is never compared", async () => {
  const { services } = makeServices({ videos, defaults: { defaultLanguage: null, defaultAudioLanguage: "zxx" } });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.deepEqual(report.deviations.map((d) => d.videoId), ["c", "d"]);
  assert.ok(report.deviations.every((d) => d.defaultLanguageDeviates === false));
});

test("report states API writability: defaultLanguage yes, defaultAudioLanguage no", async () => {
  const { services } = makeServices({ videos });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.equal(report.defaultLanguageWritableViaApi, true);
  assert.equal(report.defaultAudioLanguageWritableViaApi, false);
});

test("setDefaults stores en + zxx, and null/blank clears a field", async () => {
  const { services, getStored } = makeServices({ videos });
  assert.deepEqual(await services.setDefaults({ channelId: "ch", defaultLanguage: "en", defaultAudioLanguage: "zxx" }), {
    defaultLanguage: "en",
    defaultAudioLanguage: "zxx",
  });
  await services.setDefaults({ channelId: "ch", defaultLanguage: " ", defaultAudioLanguage: null });
  assert.deepEqual(getStored(), { defaultLanguage: null, defaultAudioLanguage: null });
});

test("setDefaults rejects an unsupported code, and zxx is not accepted as Title/description language", async () => {
  const { services } = makeServices({ videos });
  await assert.rejects(() => services.setDefaults({ channelId: "ch", defaultLanguage: "xx-nope", defaultAudioLanguage: null }));
  await assert.rejects(() => services.setDefaults({ channelId: "ch", defaultLanguage: "zxx", defaultAudioLanguage: null }));
});

test("an unsynchronized channel fails closed with not_found", async () => {
  const { services } = makeServices({ videos, channelExists: false });
  await assert.rejects(() => services.getDeviations({ channelId: "ch" }), (e: { code?: string }) => e.code === "not_found");
  await assert.rejects(() => services.setDefaults({ channelId: "ch", defaultLanguage: "en", defaultAudioLanguage: null }), (e: { code?: string }) => e.code === "not_found");
});
