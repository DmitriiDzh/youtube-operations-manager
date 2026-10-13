import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { isDomainError } from "@/lib/shared-domain";
import type { ScannedPackage } from "./package-scan";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import { createUploadApproval, estimateUploadUnits, type UploadApprovalDeps } from "./upload-approval";

// BL-182 stage 2 -- the approval (FO-REQ-0023 §4 B4; PUBLISHING_PLAN.md §2 stage 2 item 4; ADR 0037 §3–§5). Requirements:
// - AC-UP-01: it binds to what the owner saw: each manifest's hash and the settings shown; anything changed since refuses it whole;
// - AC-UP-01b: a package that is not ready, already uploaded or already queued is refused;
// - AC-UP-01c: settings that differ between the computers refuse it until chosen in Merge;
// - AC-UP-02: a dated row is published at its time, which must be more than 15 minutes ahead; a row without a date only uploads;
// - quota: `videos.insert` has its own bucket of 100 a day; the pool units are checked like a batch's (BL-117), an unknown
//   quota needs the owner's acknowledgement.
// Expected values are worked out by hand.

const NOW = new Date("2026-10-13T12:00:00Z");
const SETTINGS = { ...DEFAULT_PUBLISHING_SETTINGS, playlistId: "PL_jazz" };

function scanned(video: string, over: Partial<ScannedPackage> = {}): ScannedPackage {
  const folder = `04 Videos/10 October/x ${video}`;
  return {
    manifestPath: `${folder}/${video}_release.json`,
    folder,
    video,
    title: `Title ${video}`,
    plannedPublishDate: "2026-10-24",
    thumbnailPath: `${folder}/Thumbnail_${video}_A.jpg`,
    sizeBytes: 1000,
    durationSeconds: 7200,
    state: "ready",
    problems: [],
    youtube: null,
    manifestSha256: `sha-${video}`,
    pkg: {
      channelId: "UC_t",
      video,
      mix: 1,
      plannedPublishDate: "2026-10-24",
      files: { video: `${video} Tropico Jazz.mp4`, thumbnail: `Thumbnail_${video}_A.jpg` },
      sizeBytes: 1000,
      durationSeconds: 7200,
      title: `Title ${video}`,
      description: "00:00 A",
      tags: ["jazz"],
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
      ready: true,
      problems: [],
    },
    ...over,
  };
}

function harness(packages: ScannedPackage[], over: Partial<UploadApprovalDeps> = {}) {
  const inserted: StoredPublishingUpload[] = [];
  const unitsAsked: number[] = [];
  let id = 0;
  const deps: UploadApprovalDeps = {
    scan: async () => ({ status: "ok", packages }),
    settings: async () => ({ channelId: "UC_t", settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["playlistId"], conflictedFields: [] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    insertsToday: async () => 0,
    checkUnits: async (units) => {
      unitsAsked.push(units);
      return { decision: "allow", estimatedUnits: units, remainingUnits: 9000 };
    },
    insert: async (rows) => {
      inserted.push(...rows);
      return true;
    },
    newId: () => `up-${++id}`,
    audit: async () => undefined,
    clock: { now: () => NOW },
    ...over,
  };
  return { approval: createUploadApproval(deps), inserted, unitsAsked };
}

const item = (video: string, publishAt: string | null = "2026-10-24T12:00:00.000Z") => ({ manifestPath: `04 Videos/10 October/x ${video}/${video}_release.json`, manifestSha256: `sha-${video}`, publishAt });
const refusedWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);

test("an approval queues each row as it was shown: the package, the settings, the publish time, private + dated", async () => {
  const h = harness([scanned("V65"), scanned("V66")]);
  const result = await h.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V65"), item("V66", null)], shownSettings: SETTINGS });
  assert.deepEqual(result.uploads, [
    { id: "up-1", video: "V65", publishAt: "2026-10-24T12:00:00.000Z" },
    { id: "up-2", video: "V66", publishAt: null },
  ]);
  const [first, second] = h.inserted;
  assert.deepEqual([first.status, first.approvedBy, first.totalBytes, first.manifestSha256], ["queued", "u-owner", 1000, "sha-V65"]);
  assert.deepEqual(JSON.parse(first.settingsJson), SETTINGS);
  assert.deepEqual(JSON.parse(first.packageJson).videoFile, "04 Videos/10 October/x V65/V65 Tropico Jazz.mp4");
  assert.equal(second.publishAt, null, "a row without a date only uploads");
  // Units by hand: each upload 50 + 45 + 51 (playlist) = 146; both at insert or undated -> 292.
  assert.deepEqual(h.unitsAsked, [292]);
  assert.equal(result.estimatedUnits, 292);
});

test("AC-UP-01: a manifest changed since it was shown, or settings changed since, refuse the whole approval", async () => {
  const changed = harness([scanned("V65", { manifestSha256: "sha-edited" }), scanned("V66")]);
  await refusedWith(changed.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V66"), item("V65")], shownSettings: SETTINGS }), "upload_package_changed");
  assert.deepEqual(changed.inserted, [], "nothing is queued, not even the unchanged V66");
  const settings = harness([scanned("V65")]);
  await refusedWith(settings.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: { ...SETTINGS, publishTimeUtc: "13:00" } }), "publishing_settings_changed");
  assert.deepEqual(settings.inserted, []);
});

test("AC-UP-01b: not ready, already uploaded, or already queued is refused", async () => {
  const notReady = harness([scanned("V65", { state: "not_ready", problems: [{ code: "thumbnail_missing" }] })]);
  await refusedWith(notReady.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "upload_package_not_ready");
  const uploaded = harness([scanned("V65", { state: "scheduled", youtube: { videoId: "v", privacyStatus: "private", publishAt: null } })]);
  await refusedWith(uploaded.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "upload_already_queued");
  const queued = harness([scanned("V65")], { liveVideos: async () => new Set(["V65"]) });
  await refusedWith(queued.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "upload_already_queued");
  const raced = harness([scanned("V65")], { insert: async () => false });
  await refusedWith(raced.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "upload_already_queued");
});

test("AC-UP-01c: settings that differ between the computers refuse the approval until chosen in Merge", async () => {
  const h = harness([scanned("V65")], {
    settings: async () => ({ channelId: "UC_t", settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: [], conflictedFields: ["publishTimeUtc"] }),
  });
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "publishing_settings_changed");
});

test("AC-UP-02: a publish time 15 minutes ahead or less is refused; 15 minutes and a second is allowed", async () => {
  const h = harness([scanned("V65")]);
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65", "2026-10-13T12:15:00.000Z")], shownSettings: SETTINGS }), "publish_at_too_soon");
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65", "2026-10-12T12:00:00.000Z")], shownSettings: SETTINGS }), "publish_at_too_soon");
  const ok = await h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65", "2026-10-13T12:15:01.000Z")], shownSettings: SETTINGS });
  assert.equal(ok.uploads[0].publishAt, "2026-10-13T12:15:01.000Z");
  // That time is less than 6 h ahead: the publish time is written after processing -> 146 + 53 = 199 units.
  assert.equal(ok.estimatedUnits, 199);
});

test("quota: the 100-a-day upload bucket, the pool units like a batch's, an unknown quota only with the owner's yes", async () => {
  const bucket = harness([scanned("V65"), scanned("V66")], { insertsToday: async () => 99 });
  await refusedWith(bucket.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V66")], shownSettings: SETTINGS }), "upload_daily_limit");
  const pool = harness([scanned("V65")], { checkUnits: async (units) => ({ decision: "insufficient", estimatedUnits: units, remainingUnits: 100, resetsAt: "2026-10-14T07:00:00Z" }) });
  await refusedWith(pool.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "quota_insufficient");
  const unknown = harness([scanned("V65")], { checkUnits: async (units) => ({ decision: "unknown", estimatedUnits: units, cloudConnected: false }) });
  await refusedWith(unknown.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "quota_unknown");
  const acknowledged = await unknown.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS, acknowledgeUnknownQuota: true });
  assert.equal(acknowledged.uploads.length, 1);
});

test("the estimate: thumbnail, reads, and the playlist item and deferred publish time only when they happen", () => {
  assert.equal(estimateUploadUnits({ playlist: false, deferredPublishAt: false }), 95);
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true }), 199);
});

test("a listed package twice, two rows of one video, an empty or too large selection are refused", async () => {
  const h = harness([scanned("V65")]);
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [], shownSettings: SETTINGS }), "validation_failed");
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V65")], shownSettings: SETTINGS }), "validation_failed");
  const many = Array.from({ length: 26 }, (_, i) => item(`V${i}`));
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: many, shownSettings: SETTINGS }), "validation_failed");
});

test("AC-UP-12: a package another computer reports as uploading cannot be started here", async () => {
  const h = harness([scanned("V65"), scanned("V66")], { peerUploads: async () => new Map([["V65", "Windows-PC"]]) });
  await assert.rejects(
    h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V66"), item("V65")], shownSettings: SETTINGS }),
    (error: unknown) => isDomainError(error) && error.code === "upload_already_queued" && /Windows-PC/.test(error.message)
  );
  assert.deepEqual(h.inserted, [], "nothing of the approval is queued");
});
