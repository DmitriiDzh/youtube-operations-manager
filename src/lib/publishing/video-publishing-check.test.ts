import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import type { PublishingSettingsView } from "./settings-service";
import { createVideoPublishingCheck, hasEnglishCaptions, type ReadVideoFields, type UploadedPackageVideo, type VideoPublishingCheckDeps } from "./video-publishing-check";

// BL-279 (owner TG 4964: «инструменты для продюсера чтобы он мог читать и проверять эти поля»). Requirements, by hand: per video (an id
// list, or every package-uploaded video of the channel) YouTube's categoryId, languages, license, selfDeclaredMadeForKids, embeddable,
// containsSyntheticMedia and caption tracks (English present?) against the channel's publishing settings, each expectation marked
// saved / default / package; batched videos.list (≤ 50 ids, 1 unit a call); captions only on request (50 units a video); a video of
// another channel shows no value; read-only.

const CH = "UC_wwe";
const PRODUCER = { kind: "producer" } as const;

const view = (over: Partial<PublishingSettingsView> = {}): PublishingSettingsView => ({
  channelId: CH,
  settings: { ...DEFAULT_PUBLISHING_SETTINGS, categoryId: "27", captionsEnabled: true },
  defaults: DEFAULT_PUBLISHING_SETTINGS,
  saved: ["categoryId", "captionsEnabled"],
  conflictedFields: [],
  ...over,
});
const read = (over: Partial<ReadVideoFields> = {}): ReadVideoFields => ({
  channelId: CH,
  title: "T",
  categoryId: "27",
  defaultLanguage: "en",
  defaultAudioLanguage: "en-US",
  privacyStatus: "public",
  license: "youtube",
  selfDeclaredMadeForKids: false,
  madeForKids: false,
  embeddable: true,
  containsSyntheticMedia: true,
  hasPaidProductPlacement: false,
  ...over,
});
const pkg = (video: string, videoId: string, over: Partial<UploadedPackageVideo> = {}): UploadedPackageVideo => ({ video, videoId, defaultLanguage: "en", defaultAudioLanguage: "en-US", containsSyntheticMedia: null, hasCaptions: true, ...over });

function harness(over: Partial<VideoPublishingCheckDeps> = {}, reads: Record<string, ReadVideoFields> = {}) {
  const calls = { batches: [] as string[][], captions: [] as string[] };
  const deps: VideoPublishingCheckDeps = {
    settings: async () => view(),
    uploadedVideos: async () => [pkg("V1", "vidA111"), pkg("V2", "vidB222")],
    credentialRef: async () => ({ userId: "u" }),
    readVideos: async ({ videoIds }) => {
      calls.batches.push(videoIds);
      return new Map(videoIds.filter((id) => reads[id] !== undefined || id.startsWith("vid")).map((id) => [id, reads[id] ?? read()]));
    },
    captions: async ({ videoId }) => {
      calls.captions.push(videoId);
      return [{ language: "en", trackKind: "standard", status: "serving", isDraft: false }];
    },
    ...over,
  };
  return { svc: createVideoPublishingCheck(deps), calls };
}

test("BL-279: every package-uploaded video by default; a WWE video uploaded as Music shows a categoryId mismatch against the saved 27", async () => {
  const h = harness({}, { vidA111: read({ categoryId: "10" }) });
  const result = await h.svc.check({ channelId: CH }, PRODUCER);
  assert.deepEqual(h.calls.batches, [["vidA111", "vidB222"]]);
  assert.equal(result.quotaUnits, 1);
  assert.equal(result.mismatched, 1);
  const a = result.videos[0];
  assert.ok(a.found);
  assert.deepEqual(a.mismatches, ["categoryId"]);
  const category = a.fields.find((f) => f.field === "categoryId");
  assert.deepEqual(category, { field: "categoryId", youtube: "10", expected: "27", source: "saved", status: "mismatch" });
  assert.equal(a.fields.find((f) => f.field === "license")?.source, "default", "a field never saved is marked default");
  assert.equal(a.fields.find((f) => f.field === "defaultAudioLanguage")?.source, "package");
  assert.equal(a.fields.find((f) => f.field === "englishCaptions")?.status, "unreadable", "captions are not read unless asked");
  assert.equal(h.calls.captions.length, 0);
});

test("BL-279: with captions: true each found video's tracks are read (50 units each); the English check follows the switch and the package", async () => {
  const h = harness({
    uploadedVideos: async () => [pkg("V1", "vidA111"), pkg("S2", "vidB222", { hasCaptions: false })],
    captions: async ({ videoId }) => (videoId === "vidA111" ? [{ language: "en", trackKind: "asr", status: "serving", isDraft: false }] : []),
  });
  const result = await h.svc.check({ channelId: CH, captions: true }, PRODUCER);
  assert.equal(result.quotaUnits, 1 + 2 * 50);
  const [a, b] = result.videos;
  assert.ok(a.found && b.found);
  // V1's package has captions and the switch is on: only an automatic (ASR) track is there -> a mismatch.
  assert.deepEqual(a.fields.find((f) => f.field === "englishCaptions"), { field: "englishCaptions", youtube: false, expected: true, source: "saved", status: "mismatch" });
  // S2's package has none: none expected, none there.
  assert.equal(b.fields.find((f) => f.field === "englishCaptions")?.status, "match");
});

test("BL-279: ids are read 50 per call, a video of another channel shows no value, one YouTube does not return is not_on_youtube", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(4, "0")}`);
  const h = harness({}, { vid0001: read({ channelId: "UC_other", categoryId: "10" }) });
  const result = await h.svc.check({ channelId: CH, videoIds: [...ids, "gone12345"] }, PRODUCER);
  assert.deepEqual(h.calls.batches.map((b) => b.length), [50, 50, 21]);
  assert.equal(result.quotaUnits, 3);
  assert.deepEqual(result.videos[1], { videoId: "vid0001", video: null, found: false, reason: "not_in_channel" });
  assert.deepEqual(result.videos.at(-1), { videoId: "gone12345", video: null, found: false, reason: "not_on_youtube" });
  const unknown = result.videos[0];
  assert.ok(unknown.found);
  assert.equal(unknown.fields.find((f) => f.field === "defaultLanguage")?.status, "unchecked", "no package here names it: nothing to compare the languages with");
});

test("BL-279: a channel that never saved its settings is reported (settingsSaved false, every expectation a default)", async () => {
  const h = harness({ settings: async () => view({ settings: DEFAULT_PUBLISHING_SETTINGS, saved: [] }) }, { vidA111: read({ categoryId: "10" }) });
  const result = await h.svc.check({ channelId: CH, videoIds: ["vidA111"] }, PRODUCER);
  assert.equal(result.settingsSaved, false);
  const a = result.videos[0];
  assert.ok(a.found);
  assert.equal(a.fields.find((f) => f.field === "categoryId")?.source, "default");
});

test("BL-279: a field YouTube omits is unreadable, never a mismatch; a package's own synthetic-media mark is the expectation", async () => {
  const h = harness({ uploadedVideos: async () => [pkg("V1", "vidA111", { containsSyntheticMedia: false })] }, { vidA111: read({ hasPaidProductPlacement: null, containsSyntheticMedia: true }) });
  const result = await h.svc.check({ channelId: CH }, PRODUCER);
  const a = result.videos[0];
  assert.ok(a.found);
  assert.equal(a.fields.find((f) => f.field === "paidProductPlacement")?.status, "unreadable");
  assert.deepEqual(a.fields.find((f) => f.field === "containsSyntheticMedia"), { field: "containsSyntheticMedia", youtube: true, expected: false, source: "package", status: "mismatch" });
});

test("BL-279: bad input is refused before any read; captions on more than 50 videos are refused (quota)", async () => {
  const h = harness();
  const code = (c: string) => (error: unknown) => isDomainError(error) && error.code === c;
  await assert.rejects(h.svc.check({ channelId: CH, videoIds: [] }, PRODUCER), code("validation_failed"));
  await assert.rejects(h.svc.check({ channelId: CH, videoIds: ["bad id!"] }, PRODUCER), code("validation_failed"));
  await assert.rejects(h.svc.check({ channelId: CH, videoIds: Array.from({ length: 51 }, (_, i) => `vid${String(i).padStart(4, "0")}`), captions: true }, PRODUCER), code("validation_failed"));
  assert.equal(h.calls.batches.length, 0);
  const none = harness({ uploadedVideos: async () => "no_workspace" });
  await assert.rejects(none.svc.check({ channelId: CH }, PRODUCER), code("package_no_workspace"));
});

test("BL-279: one video's caption tracks failing to read leaves that check unreadable with the code, the rest stands", async () => {
  const h = harness({
    captions: async () => {
      throw new DomainError({ code: "captions_scope_missing", message: "x" });
    },
  });
  const result = await h.svc.check({ channelId: CH, captions: true }, PRODUCER);
  const a = result.videos[0];
  assert.ok(a.found);
  assert.equal(a.captionsError, "captions_scope_missing");
  assert.equal(a.fields.find((f) => f.field === "englishCaptions")?.status, "unreadable");
});

test("hasEnglishCaptions: en / en-GB standard or forced tracks count; ASR and drafts do not", () => {
  assert.equal(hasEnglishCaptions([{ language: "en-GB", trackKind: "standard", status: "serving", isDraft: false }]), true);
  assert.equal(hasEnglishCaptions([{ language: "en", trackKind: "forced", status: "serving", isDraft: null }]), true);
  assert.equal(hasEnglishCaptions([{ language: "en", trackKind: "ASR", status: "serving", isDraft: false }]), false);
  assert.equal(hasEnglishCaptions([{ language: "en", trackKind: "standard", status: "serving", isDraft: true }]), false);
  assert.equal(hasEnglishCaptions([{ language: "eng", trackKind: "standard", status: "serving", isDraft: false }]), false);
});
