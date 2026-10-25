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
    pending: async () => ({ inserts: 0, units: 0 }),
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
  // Units by hand: each upload 50 + 45 + 51 (playlist) = 146; the dated V65 also pays its publish-time write, now always after the
  // upload (owner msgs 3510/3511 replaced msg 2717's "at insert when 6 h or more ahead", which made it free): 50 + 3 + 2 reads = 55.
  // 146 + 55 + 146 = 347.
  assert.deepEqual(h.unitsAsked, [347]);
  assert.equal(result.estimatedUnits, 347);
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
  // The publish time is written after the upload (owner msgs 3510/3511: always, last) -> 146 + 55 = 201 units.
  assert.equal(ok.estimatedUnits, 201);
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
  // The publish time: videos.update 50 + video-details' own 3 reads + the runner's read before and after = 55 (was
  // 53 before owner msgs 3510/3511 added the runner's two reads around the write).
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true }), 201);
});

test("a listed package twice, two rows of one video, an empty or too large selection are refused", async () => {
  const h = harness([scanned("V65")]);
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [], shownSettings: SETTINGS }), "validation_failed");
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V65")], shownSettings: SETTINGS }), "validation_failed");
  const many = Array.from({ length: 26 }, (_, i) => item(`V${i}`));
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: many, shownSettings: SETTINGS }), "validation_failed");
});

test("AC-UP-12: a package another computer reports as uploading cannot be started here", async () => {
  const h = harness([scanned("V65"), scanned("V66")], { peerUploads: async () => new Map([["V65", { host: "Windows-PC", uploaded: false }]]) });
  await assert.rejects(
    h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V66"), item("V65")], shownSettings: SETTINGS }),
    (error: unknown) => isDomainError(error) && error.code === "upload_already_queued" && /Windows-PC/.test(error.message)
  );
  assert.deepEqual(h.inserted, [], "nothing of the approval is queued");
});

// Review should-fix 4: the uploads already queued here have not spent their insert or units yet; a second approval the same day
// counts them, so two approvals cannot together pass the 100-a-day bucket or the pool.
test("quota: uploads already queued count against the day's inserts and units", async () => {
  const bucket = harness([scanned("V65"), scanned("V66")], { insertsToday: async () => 90, pending: async () => ({ inserts: 9, units: 0 }) });
  await refusedWith(bucket.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V66")], shownSettings: SETTINGS }), "upload_daily_limit");
  const units = harness([scanned("V65")], { pending: async () => ({ inserts: 3, units: 500 }) });
  await units.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS });
  assert.deepEqual(units.unitsAsked, [146 + 55 + 500], "this dated upload's 201 units (its date is written after the upload, owner msgs 3510/3511) and the queued ones' 500");
});

test("AC-UP-12: a package another computer already uploaded is refused with that said", async () => {
  const h = harness([scanned("V65")], { peerUploads: async () => new Map([["V65", { host: "Windows-PC", uploaded: true }]]) });
  await assert.rejects(
    h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }),
    (error: unknown) => isDomainError(error) && error.code === "upload_already_queued" && /already uploaded from Windows-PC/.test(error.message)
  );
});

// Requirement changed by the owner (msg 2817, FO-MSG-0017 option «б»; was msgs 2751/2753 "added after the package's"): a package
// with its own tags uploads only those; a package with tags: [] uploads the channel's common tags.
test("channel tags: used only for a package without tags; a package's own tags replace them", async () => {
  const withTags = { ...SETTINGS, channelTags: ["Jazz", "tropical jazz"] };
  const settings = async () => ({ channelId: "UC_t", settings: withTags, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["channelTags" as const], conflictedFields: [] });
  const h = harness([scanned("V65")], { settings });
  await h.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V65")], shownSettings: withTags });
  assert.deepEqual(JSON.parse(h.inserted[0].packageJson).tags, ["jazz"]);

  const base = scanned("V66");
  const empty: ScannedPackage = { ...base, pkg: { ...base.pkg!, tags: [] } };
  const e = harness([empty], { settings });
  await e.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V66")], shownSettings: withTags });
  assert.deepEqual(JSON.parse(e.inserted[0].packageJson).tags, ["Jazz", "tropical jazz"]);

  // By hand: 5 package tags of 99 characters = 495 + 4 commas = 499. The channel's "x" is not added (it would have made 501).
  const long: ScannedPackage = { ...base, pkg: { ...base.pkg!, tags: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(99)) } };
  const fits = harness([long], { settings: async () => ({ ...(await settings()), settings: { ...withTags, channelTags: ["x"] } }) });
  await fits.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V66")], shownSettings: { ...withTags, channelTags: ["x"] } });
  assert.deepEqual(JSON.parse(fits.inserted[0].packageJson).tags, long.pkg!.tags);
});

// Independent review (FO-MSG-0017, owner msg 2817 + AC-UP-01): for a package with tags: [] the channel's tags are what the owner
// approves, so they bind like any shown setting -- a change after they were shown refuses the approval whole. And the 500-character
// refusal still guards the channel's list when it is the one sent (a stored list that never passed the settings check). By hand: six
// tags of 90 digits = 540 + 5 commas = 545 > 500.
test("channel tags for a package with tags: []: bound to what was shown, and refused over YouTube's 500 characters", async () => {
  const base = scanned("V67");
  const empty: ScannedPackage = { ...base, pkg: { ...base.pkg!, tags: [] } };
  const shown = { ...SETTINGS, channelTags: ["jazz"] };
  const now = { ...SETTINGS, channelTags: ["jazz", "piano"] };
  const changed = harness([empty], { settings: async () => ({ channelId: "UC_t", settings: now, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["channelTags" as const], conflictedFields: [] }) });
  await refusedWith(changed.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V67")], shownSettings: shown }), "publishing_settings_changed");
  assert.equal(changed.inserted.length, 0);

  const huge = { ...SETTINGS, channelTags: Array.from({ length: 6 }, (_, i) => `${i}`.repeat(90)) };
  const over = harness([empty], { settings: async () => ({ channelId: "UC_t", settings: huge, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["channelTags" as const], conflictedFields: [] }) });
  await refusedWith(over.approval.approve({ channelId: "UC_t", userId: "u-owner", items: [item("V67")], shownSettings: huge }), "upload_tags_too_long");
  assert.equal(over.inserted.length, 0);
});

// BL-225 stage 2 (FO-REQ-0040 acceptance 4, ADR 0051): the slot a v2 package names is kept on its upload row; a v1 package has none.
test("AC-WP-23: the upload row keeps the plan slot of a v2 package (null for v1)", async () => {
  const v2 = scanned("V65");
  v2.pkg = { ...v2.pkg!, schemaVersion: 2, slotId: "w44-mon" };
  const h = harness([v2, scanned("V66")]);
  await h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V66")], shownSettings: SETTINGS });
  assert.deepEqual(h.inserted.map((row) => [row.video, row.slotId]), [["V65", "w44-mon"], ["V66", null]]);
});

// BL-225 stage 3 (ADR 0051 §8): the frozen package carries a v2 package's translations as the shared rules send them (the title
// trimmed, CRLF made LF), its own AI flag and its slot; a v1 package carries none of them.
test("AC-WP-30: the frozen package holds the v2 translations (checked form), the AI flag and the slot", async () => {
  const v2 = scanned("V65");
  v2.pkg = { ...v2.pkg!, schemaVersion: 2, slotId: "w44-mon", containsSyntheticMedia: false, localizations: { ja: { title: "  夜明け  ", description: "田んぼ\r\n朝" } } };
  const h = harness([v2, scanned("V66")]);
  await h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65"), item("V66")], shownSettings: SETTINGS });
  const [first, second] = h.inserted.map((row) => JSON.parse(row.packageJson));
  assert.deepEqual([first.localizations, first.containsSyntheticMedia, first.slotId], [{ ja: { title: "夜明け", description: "田んぼ\n朝" } }, false, "w44-mon"]);
  assert.deepEqual([second.localizations, second.containsSyntheticMedia, second.slotId], [undefined, undefined, undefined]);
});

// Review #5 (LOW): two packages naming the same plan slot could both upload and be scheduled. A package whose slot an upload here
// already holds (another video) is refused: `upload_slot_taken`.
test("review #5: a package whose slot is held by another video's upload is refused, nothing queued", async () => {
  const v2 = scanned("V65");
  v2.pkg = { ...v2.pkg!, schemaVersion: 2, slotId: "w44-mon" };
  const h = harness([v2], { heldSlots: async () => new Set(["w44-mon"]) });
  await refusedWith(h.approval.approve({ channelId: "UC_t", userId: "u", items: [item("V65")], shownSettings: SETTINGS }), "upload_slot_taken");
  assert.deepEqual(h.inserted, []);
});
