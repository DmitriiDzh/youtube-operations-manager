import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { computePublishingCoverage, createPublishingCoverageReads, type CoverageSourceVideo, type PublishingCoveragePorts } from "./index";

// BL-235 acceptance (owner, Telegram msg 3806): a publishing day is covered when a video is uploaded and scheduled for that day (or
// already published that day) AND has all its translations; computed from the synced copy. Expected values are worked out by hand
// from that rule, the calendar's existing rule (overdue / undated / live never cover; BL-182) and the Languages tab's rule (tracked
// languages minus the video's own, non-empty title, non-empty description where the original has one; BL-178 part C):
// - zone Asia/Tokyo is UTC+9 all year; now = 2026-11-05T03:00:00Z is 12:00 on 2026-11-05 in Tokyo, so 7 days = 11-05 .. 11-11.

const NOW = new Date("2026-11-05T03:00:00.000Z");
const TZ = "Asia/Tokyo";
const TRACKED = ["de", "es", "ja"];
const FULL = {
  de: { title: "Titel", description: "Beschreibung" },
  es: { title: "Título", description: "Descripción" },
  ja: { title: "タイトル", description: "説明" },
};

function video(id: string, fields: Partial<CoverageSourceVideo>): CoverageSourceVideo {
  return {
    videoId: id,
    title: `Video ${id}`,
    description: "English description",
    privacyStatus: "private",
    publishedAt: "2026-11-01T00:00:00.000Z",
    publishAt: null,
    liveBroadcastContent: "none",
    defaultLanguage: "en",
    localizations: { ...FULL },
    ...fields,
  };
}

function run(videos: CoverageSourceVideo[], overrides: Partial<Parameters<typeof computePublishingCoverage>[0]> = {}) {
  return computePublishingCoverage({ videos, channelSyncedAtMs: null, trackedLanguages: TRACKED, channelLanguage: "en", timeZone: TZ, fromDate: "2026-11-05", days: 7, now: NOW, ...overrides });
}

test("BL-235: a week of every case -- covered, missing translations, gaps, the zone's day boundary, two videos a day", () => {
  const { es: _es, ...noEs } = FULL;
  void _es;
  const report = run([
    // 11-05 18:00 Tokyo, every tracked language -> covered.
    video("V1", { publishAt: "2026-11-05T09:00:00.000Z" }),
    // 16:00Z on 11-06 is 01:00 on 11-07 in Tokyo: covers 11-07, leaves 11-06 a gap.
    video("V2", { publishAt: "2026-11-06T16:00:00.000Z" }),
    // 11-08: Spanish entry with an empty title -> missing es.
    video("V3", { publishAt: "2026-11-08T03:00:00.000Z", localizations: { ...noEs, es: { title: "", description: "Descripción" } } }),
    // A private upload without a date (uploaded on 11-09) covers nothing.
    video("V5", { publishedAt: "2026-11-09T03:00:00.000Z" }),
    // 11-10: one lacks de and es, the other is complete -> covered, both listed.
    video("V6", { publishAt: "2026-11-10T01:00:00.000Z", localizations: { ja: FULL.ja } }),
    video("V7", { publishAt: "2026-11-10T05:00:00.000Z" }),
    // 11-11: both lack something; the closest to covered lacks only ja (an empty description where the original has one).
    video("V8", { publishAt: "2026-11-11T01:00:00.000Z", localizations: {} }),
    video("V9", { publishAt: "2026-11-11T02:00:00.000Z", localizations: { ...FULL, ja: { title: "タイトル", description: "" } } }),
  ]);
  assert.equal(report.from, "2026-11-05");
  assert.equal(report.to, "2026-11-11");
  assert.deepEqual(
    report.days.map((d) => [d.date, d.status, d.videoIds, d.missingLanguages]),
    [
      ["2026-11-05", "covered", ["V1"], []],
      ["2026-11-06", "gap", [], []],
      ["2026-11-07", "covered", ["V2"], []],
      ["2026-11-08", "missing_translations", ["V3"], ["es"]],
      ["2026-11-09", "gap", [], []],
      ["2026-11-10", "covered", ["V6", "V7"], []],
      ["2026-11-11", "missing_translations", ["V8", "V9"], ["ja"]],
    ]
  );
  assert.deepEqual(
    report.days[5].videos.map((v) => [v.videoId, v.kind, v.missingLanguages]),
    [
      ["V6", "scheduled", ["de", "es"]],
      ["V7", "scheduled", []],
    ]
  );
  assert.deepEqual(report.days[6].videos[0].missingLanguages, ["de", "es", "ja"]);
  assert.deepEqual(report.summary, { covered: 3, missingTranslations: 2, gaps: 2, coveredDaysInARow: 1 });
});

test("BL-235: a video published that day covers it; overdue, live and undated videos never do", () => {
  const report = run(
    [
      // Public since 10:00 Tokyo on 11-05 -> covers 11-05 (published at its publish time).
      video("P1", { privacyStatus: "public", publishedAt: "2026-11-05T01:00:00.000Z" }),
      // Private with a date that passed (11-05 11:00 Tokyo, before now) while the copy shows it not public -> overdue.
      video("O1", { publishAt: "2026-11-05T02:00:00.000Z" }),
      // Unlisted counts as published (the calendar's rule): 11-06 12:00 Tokyo.
      video("U1", { privacyStatus: "unlisted", publishedAt: "2026-11-06T03:00:00.000Z" }),
      // An upcoming live broadcast scheduled for 11-07 is not a release.
      video("L1", { publishAt: "2026-11-07T03:00:00.000Z", liveBroadcastContent: "upcoming" }),
    ],
    { days: 3 }
  );
  assert.deepEqual(
    report.days.map((d) => [d.date, d.status, d.videoIds]),
    [
      ["2026-11-05", "covered", ["P1"]],
      ["2026-11-06", "covered", ["U1"]],
      ["2026-11-07", "gap", []],
    ]
  );
  // The overdue video is shown on its day for information (in time order: P1 01:00Z, O1 02:00Z), but it is not one of the
  // day's videoIds.
  assert.deepEqual(
    report.days[0].videos.map((v) => [v.videoId, v.kind]),
    [
      ["P1", "published"],
      ["O1", "overdue"],
    ]
  );
});

test("BL-235: an overdue video alone leaves its day a gap", () => {
  const report = run([video("O1", { publishAt: "2026-11-05T02:00:00.000Z" })], { days: 1 });
  assert.equal(report.days[0].status, "gap");
  assert.deepEqual(report.days[0].videoIds, []);
  assert.deepEqual(report.summary, { covered: 0, missingTranslations: 0, gaps: 1, coveredDaysInARow: 0 });
});

test("BL-235: the video's own language is never required", () => {
  // Channel language en, tracked en + de: an English video needs only de.
  const own = run([video("E1", { publishAt: "2026-11-05T09:00:00.000Z", localizations: { de: FULL.de } })], { trackedLanguages: ["en", "de"], days: 1 });
  assert.equal(own.days[0].status, "covered");
  // No channel language: a Japanese video needs de and es, not ja.
  const ja = run([video("J1", { publishAt: "2026-11-05T09:00:00.000Z", defaultLanguage: "ja", localizations: { de: FULL.de } })], { channelLanguage: null, days: 1 });
  assert.equal(ja.days[0].status, "missing_translations");
  assert.deepEqual(ja.days[0].missingLanguages, ["es"]);
});

test("BL-235: no tracked languages -- nothing is required, a scheduled video covers its day", () => {
  const report = run([video("N1", { publishAt: "2026-11-05T09:00:00.000Z", localizations: {} })], { trackedLanguages: [], days: 1 });
  assert.equal(report.days[0].status, "covered");
});

test("BL-235: a row the latest sync no longer returned (deleted in Studio) covers nothing", () => {
  const synced = Date.parse("2026-11-05T02:00:00.000Z");
  const report = run([{ ...video("D1", { publishAt: "2026-11-05T09:00:00.000Z" }), syncedAtMs: synced - 60_000 }], { channelSyncedAtMs: synced, days: 1 });
  assert.equal(report.days[0].status, "gap");
});

test("BL-235: days are counted by the calendar, also across a DST change (Europe/Berlin, 2026-10-25)", () => {
  // 2026-10-25T22:30Z is 23:30 on 10-25 in Berlin (UTC+1 after the change at 01:00Z), 00:30 on 10-26 in UTC.
  const report = run([video("B1", { privacyStatus: "public", publishedAt: "2026-10-25T22:30:00.000Z" })], { timeZone: "Europe/Berlin", fromDate: "2026-10-24", days: 3 });
  assert.deepEqual(
    report.days.map((d) => [d.date, d.status]),
    [
      ["2026-10-24", "gap"],
      ["2026-10-25", "covered"],
      ["2026-10-26", "gap"],
    ]
  );
});

function ports(overrides: Partial<PublishingCoveragePorts> = {}): PublishingCoveragePorts {
  return {
    getChannel: async (channelId) => (channelId === "UC_1" ? { lastSyncedAt: new Date("2026-11-05T02:00:00.000Z") } : null),
    listVideos: async () => [video("V1", { publishAt: "2026-11-05T09:00:00.000Z", syncedAtMs: Date.parse("2026-11-05T02:00:00.000Z") })],
    trackedLanguages: async () => ["ja", "de", "es"],
    channelLanguage: async () => "en",
    timeZoneOf: async () => ({ timeZone: TZ, source: "publishing_plan" }),
    clock: { now: () => NOW },
    ...overrides,
  };
}

test("BL-235: the read says how old the copy is (asOf), its zone, and defaults to 7 days from today there", async () => {
  const result = await createPublishingCoverageReads(ports()).get({ channelId: "UC_1" });
  assert.equal(result.asOf, "2026-11-05T02:00:00.000Z");
  assert.equal(result.timeZone, "Asia/Tokyo");
  assert.equal(result.timeZoneSource, "publishing_plan");
  assert.deepEqual(result.trackedLanguages, ["de", "es", "ja"]);
  assert.equal(result.from, "2026-11-05");
  assert.equal(result.to, "2026-11-11");
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].status, "covered");
});

test("BL-235: today is the channel's today -- 20:00Z on 11-04 is already 11-05 in Tokyo", async () => {
  const result = await createPublishingCoverageReads(ports({ clock: { now: () => new Date("2026-11-04T20:00:00.000Z") } })).get({ channelId: "UC_1", days: 1 });
  assert.equal(result.from, "2026-11-05");
});

test("BL-235: a channel never synced has asOf null; an unknown channel is not_found", async () => {
  const never = await createPublishingCoverageReads(ports({ getChannel: async () => ({ lastSyncedAt: null }) })).get({ channelId: "UC_1", days: 1 });
  assert.equal(never.asOf, null);
  await assert.rejects(createPublishingCoverageReads(ports()).get({ channelId: "UC_other" }), (error: unknown) => error instanceof DomainError && error.code === "not_found");
});

test("BL-235: days must be 1..30; unknown fields are refused", async () => {
  const reads = createPublishingCoverageReads(ports());
  for (const bad of [{ channelId: "UC_1", days: 0 }, { channelId: "UC_1", days: 31 }, { channelId: "UC_1", days: 2.5 }, { channelId: "UC_1", upload: true }]) {
    await assert.rejects(reads.get(bad), (error: unknown) => error instanceof DomainError && error.code === "validation_failed");
  }
  assert.equal((await reads.get({ channelId: "UC_1", days: 30 })).days.length, 30);
});

test("BL-235: an invalid zone falls back to UTC and says so", async () => {
  const result = await createPublishingCoverageReads(ports({ timeZoneOf: async () => ({ timeZone: "Mars/Base", source: "publishing_plan" }) })).get({ channelId: "UC_1", days: 1 });
  assert.equal(result.timeZone, "UTC");
  assert.equal(result.timeZoneSource, "utc");
});
