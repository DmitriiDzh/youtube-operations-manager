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
        defaults = { ...defaults, ...value };
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
  assert.equal(report.defaultAudioLanguageWritableViaApi, true); // owner 2026-10-02: defaultAudioLanguage is now written via video-details
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

// BL-178 (review of FO-REQ-0022): the report, the Batch write and the agent context share one rule -- language codes compare
// case-insensitively (a video `EN` under baseline `en` is not "deviating"; the Batch already treats them as equal).
test("BL-178: a different letter case is no deviation (EN vs en), a different code still is (en-US vs en)", async () => {
  const { services } = makeServices({
    videos: [
      { videoId: "x", title: "X", defaultLanguage: "EN", defaultAudioLanguage: "En" },
      { videoId: "y", title: "Y", defaultLanguage: "en-US", defaultAudioLanguage: "en" },
    ],
    defaults: { defaultLanguage: "en", defaultAudioLanguage: "en" },
  });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.deepEqual(report.deviations.map((d) => [d.videoId, d.defaultLanguageDeviates, d.defaultAudioLanguageDeviates]), [["y", true, false]]);
});

// BL-178 part B: the Languages page tells the owner when the baseline was set differently on the computers (Batches refuse
// meanwhile, PROJECT_SPEC §14), and stays silent when the store cannot tell.
test("the report carries the baseline fields set differently on the computers, when the store knows them", async () => {
  const services = createChannelLanguageDefaultsServices({
    store: {
      getChannel: async (channelId) => ({ channelId }),
      getDefaults: async () => ({ defaultLanguage: "en", defaultAudioLanguage: "en" }),
      setDefaults: async () => undefined,
      listVideos: async () => [],
      getConflictedFields: async () => ["defaultLanguage"],
    },
  });
  assert.deepEqual((await services.getDeviations({ channelId: "ch" })).conflictedFields, ["defaultLanguage"]);
  const { services: plain } = makeServices({ videos: [] });
  assert.equal("conflictedFields" in (await plain.getDeviations({ channelId: "ch" })), false);
});

// BL-178 part B (review item 3): a field left out is left unchanged -- a form that sends only what the owner changed can never
// overwrite a value that arrived from the other computer after it loaded.
test("setDefaults changes only the fields sent and returns the whole baseline", async () => {
  const { services, getStored } = makeServices({ videos: [], defaults: { defaultLanguage: "en", defaultAudioLanguage: "en" } });
  assert.deepEqual(await services.setDefaults({ channelId: "ch", defaultAudioLanguage: "zxx" }), { defaultLanguage: "en", defaultAudioLanguage: "zxx" });
  assert.deepEqual(getStored(), { defaultLanguage: "en", defaultAudioLanguage: "zxx" });
});

test("an unreadable shared document flags the report (conflictedFieldsUnknown) instead of failing it", async () => {
  const services = createChannelLanguageDefaultsServices({
    store: {
      getChannel: async (channelId) => ({ channelId }),
      getDefaults: async () => ({ defaultLanguage: "en", defaultAudioLanguage: "en" }),
      setDefaults: async () => undefined,
      listVideos: async () => [],
      getConflictedFields: async () => {
        throw new Error("corrupt document");
      },
    },
  });
  const report = await services.getDeviations({ channelId: "ch" });
  assert.equal("conflictedFields" in report, false);
  assert.equal(report.conflictedFieldsUnknown, true);
  assert.deepEqual(report.defaults, { defaultLanguage: "en", defaultAudioLanguage: "en" });
});
