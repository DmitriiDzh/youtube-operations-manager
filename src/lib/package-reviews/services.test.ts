import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type PackageReviewDecision, type PackageReviewRequired, type PackageReviewsSnapshot, type ReviewPackage } from "./contracts";
import { latestOwnerDecision, ownerReviewProblemOf, triedExceptionsOf, triedKeysOf } from "./model";
import { createPackageReviewsService, packageReviewsOwnerSurface, type PackageReviewsDeps } from "./services";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-03/04/05/06/07/09/10; ADR 0070 §3-§4, §6), amended by BL-265 (MEDIA_GATE_PLAN.md AC-MG-01..07,
// ADR 0072 §1-§2). The expected values come from the plans: an approval needs the manifest's video sha256 and this computer's mp4
// being sizeBytes long and hashing to it; it names that mp4 (videoSha256 + videoSizeBytes) and notes the thumbnail's hash but does not
// need one; a return needs a comment; an uploaded package is not reviewed (a packaging comment still is); a decision drops the plan's
// cache once; the media are only the package's own.

const CH = "UC_wwe";
const MANIFEST = "a".repeat(64);
const VIDEO_SHA = "f".repeat(64);
const THUMB_SHA = "1".repeat(64);
const FOLDER = "04 Videos/11 November/1115 V11";

function pkg(over: Partial<ReviewPackage> = {}): ReviewPackage {
  return {
    manifestSha256: MANIFEST,
    manifestPath: `${FOLDER}/V11_release.json`,
    video: "V11",
    title: "Why the bell rings",
    description: "Line 1\nLine 2",
    languages: ["de", "es"],
    slotId: "slot-1",
    plannedPublishDate: "2026-11-20",
    durationSeconds: 58,
    videoPath: `${FOLDER}/V11.mp4`,
    thumbnailPath: `${FOLDER}/Thumbnail_V11.jpg`,
    videoSha256: VIDEO_SHA,
    videoSizeBytes: 1000,
    uploaded: false,
    otherProblems: [],
    ...over,
  };
}

function harness(options: { packages?: ReviewPackage[]; hashes?: Record<string, string>; files?: string[]; unreadable?: boolean; now?: () => Date; aliases?: Map<string, string> } = {}) {
  let required: PackageReviewRequired | null = null;
  const decisions: Record<string, PackageReviewDecision> = {};
  let exists = false;
  const afterChange: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const hashed: string[] = [];
  const files = new Set(options.files ?? [`${FOLDER}/V11.mp4`, `${FOLDER}/Thumbnail_V11.jpg`]);
  const hashes: Record<string, string> = { [`/ws/${FOLDER}/V11.mp4`]: VIDEO_SHA, [`/ws/${FOLDER}/Thumbnail_V11.jpg`]: THUMB_SHA, ...(options.hashes ?? {}) };
  let n = 0;
  const scans: string[] = [];
  const deps: PackageReviewsDeps = {
    store: {
      async read(): Promise<PackageReviewsSnapshot> {
        if (options.unreadable) throw new Error("cannot load");
        return { exists, required, decisions: { ...decisions } };
      },
      async setRequired(_c, value) {
        exists = true;
        required = value;
      },
      async addDecision(_c, decision) {
        exists = true;
        decisions[decision.id] = decision;
      },
    },
    packages: async (channelId) => (scans.push(channelId), channelId === CH ? { status: "ok", packages: options.packages ?? [pkg()] } : { status: "ok", packages: [] }),
    resolveFile: async (channelId, rel) => (channelId === CH && files.has(rel) ? { path: `/ws/${rel}`, bytes: 1000 } : null),
    hashFile: async (abs) => {
      hashed.push(abs);
      return hashes[abs] ?? "0".repeat(64);
    },
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: options.now ?? (() => new Date("2026-11-15T12:00:00.000Z")),
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (e) => void audits.push(e),
    afterChange: (channelId) => void afterChange.push(channelId),
    ...(options.aliases ? { recodeAliases: async () => options.aliases! } : {}),
  };
  // A decision already in the document (e.g. one a BL-257 build wrote, without the media key).
  const seed = (decision: PackageReviewDecision) => {
    exists = true;
    decisions[decision.id] = decision;
  };
  return { service: createPackageReviewsService(deps), hashes, afterChange, audits, hashed, seed, scans, decisions: () => Object.values(decisions) };
}

async function refusedWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => isDomainError(error) && error.code === code);
}

test("AC-PR-05: approval refused without the manifest's video sha256; nothing recorded", async () => {
  const h = harness({ packages: [pkg({ videoSha256: null })] });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" }), "package_review_no_sha256");
  assert.deepEqual(h.decisions(), []);
  assert.deepEqual(h.afterChange, []);
});

test("AC-PR-05: approval refused when this computer's mp4 does not hash to the manifest's sha256, or is not here", async () => {
  const h = harness({ hashes: { [`/ws/${FOLDER}/V11.mp4`]: "e".repeat(64) } });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" }), "package_review_video_mismatch");
  const missing = harness({ files: [`${FOLDER}/Thumbnail_V11.jpg`] });
  await refusedWith(missing.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" }), "package_review_video_missing");
  assert.deepEqual([...h.decisions(), ...missing.decisions()], []);
});

test("AC-MG-04: approval refused when this computer's mp4 is not the manifest's sizeBytes long (before any hashing)", async () => {
  const h = harness({ packages: [pkg({ videoSizeBytes: 1001 })] });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" }), "package_review_video_mismatch");
  assert.deepEqual(h.decisions(), []);
  assert.deepEqual(h.hashed, [], "a different size is never hashed");
});

test("AC-PR-03/05, AC-MG-11: an approval names the mp4 (sha256 + size), keeps the manifest and the thumbnail's hash; the plan cache is dropped once (AC-PR-10)", async () => {
  const h = harness();
  const { decision, view } = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.deepEqual(decision, { id: "pr_id1", manifestSha256: MANIFEST, video: "V11", thumbnailSha256: THUMB_SHA, kind: "approved", comment: null, by: "owner", device: "Mac", at: "2026-11-15T12:00:00.000Z", videoSha256: VIDEO_SHA, videoSizeBytes: 1000 });
  assert.deepEqual(h.afterChange, [CH]);
  assert.equal(view.items[0].state, "approved");
  assert.ok(h.hashed.includes(`/ws/${FOLDER}/V11.mp4`), "the video itself was hashed");
});

test("AC-PR-04: a return needs a comment; with one it is recorded and the package reads returned; a later approval reads approved", async () => {
  const h = harness();
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned" }), "validation_failed");
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", comment: "   " }), "validation_failed");
  const returned = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", comment: " the intro is cut " });
  assert.equal(returned.decision.comment, "the intro is cut");
  assert.deepEqual([returned.view.items[0].state, returned.view.items[0].comment, returned.view.waiting], ["returned", "the intro is cut", 0]);
  const approved = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.equal(approved.view.items[0].state, "approved");
  assert.deepEqual(h.afterChange, [CH, CH], "one invalidation per decision");
});

// AC-PR-03's "a changed thumbnail reads pending again" is withdrawn by BL-265 (changed requirement, owner TG 2340, ADR 0072 §1): the
// approval covers the media only, so a new thumbnail file (packaging) keeps it.
test("AC-MG-01/05: after approval, a changed thumbnail file and a re-package with new texts keep it approved; no thumbnail is needed to approve", async () => {
  const h = harness({ files: [`${FOLDER}/V11.mp4`] });
  await h.service.setRequired(CH, { required: true });
  const { decision } = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.equal(decision.thumbnailSha256, null, "no thumbnail file: approved anyway, with no hash noted");
  const repackaged = harness({ packages: [pkg({ manifestSha256: "e".repeat(64), title: "A better title", description: "New text", languages: ["fr"] })] });
  await repackaged.service.setRequired(CH, { required: true });
  repackaged.seed(decision);
  repackaged.hashes[`/ws/${FOLDER}/Thumbnail_V11.jpg`] = "9".repeat(64);
  const view = await repackaged.service.view(CH);
  assert.deepEqual([view.items[0].state, view.items[0].decision, view.waiting], ["approved", "approved", 0]);
});

test("AC-MG-02/06: a different mp4 (sha256 or size) is pending again; a return holds its mp4 only, and a later approval of it stands", async () => {
  const h = harness();
  await h.service.setRequired(CH, { required: true });
  const { decision: returned } = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", comment: "the intro is cut" });
  assert.deepEqual([returned.videoSha256, returned.videoSizeBytes], [VIDEO_SHA, 1000], "a return names the mp4 too");
  const otherSha = harness({ packages: [pkg({ manifestSha256: "e".repeat(64), videoSha256: "c".repeat(64) })] });
  await otherSha.service.setRequired(CH, { required: true });
  otherSha.seed(returned);
  assert.equal((await otherSha.service.view(CH)).items[0].state, "pending", "a new mp4 is pending, not returned");
  const otherSize = harness({ packages: [pkg({ manifestSha256: "e".repeat(64), videoSizeBytes: 999 })] });
  await otherSize.service.setRequired(CH, { required: true });
  otherSize.seed(returned);
  assert.equal((await otherSize.service.view(CH)).items[0].state, "pending");
  const sameMp4 = harness({ packages: [pkg({ manifestSha256: "e".repeat(64), title: "retitled" })] });
  await sameMp4.service.setRequired(CH, { required: true });
  sameMp4.seed(returned);
  assert.deepEqual([(await sameMp4.service.view(CH)).items[0].state, (await sameMp4.service.view(CH)).items[0].comment], ["returned", "the intro is cut"], "the same mp4 re-packaged stays returned");
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.equal((await h.service.view(CH)).items[0].state, "approved");
});

test("AC-MG-07: a packaging comment needs a comment, never changes any package's state, and is allowed on uploaded packages and with the gate off", async () => {
  const h = harness({ packages: [pkg(), pkg({ manifestSha256: "b".repeat(64), video: "V10" }), pkg({ manifestSha256: "c".repeat(64), video: "V9", uploaded: true })] });
  await h.service.decide(CH, { manifestSha256: "b".repeat(64), kind: "packaging_comment", comment: "gate off: still fine" });
  await h.service.setRequired(CH, { required: true });
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "packaging_comment" }), "validation_failed");
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "packaging_comment", comment: "  " }), "validation_failed");
  const before = (await h.service.view(CH)).items.map((i) => [i.video, i.state, i.decision]);
  assert.deepEqual(before, [["V10", "pending", null], ["V11", "approved", "approved"]]);
  for (const sha of [MANIFEST, "b".repeat(64), "c".repeat(64)]) await h.service.decide(CH, { manifestSha256: sha, kind: "packaging_comment", comment: "shorter title, please" });
  const after = await h.service.view(CH);
  // the same states; the uploaded V9 is now listed (a decision names it) as uploaded
  assert.deepEqual(after.items.map((i) => [i.video, i.state, i.decision]), [["V10", "pending", null], ["V11", "approved", "approved"], ["V9", "uploaded", null]]);
  assert.equal(after.waiting, 1);
  assert.deepEqual(after.items.find((i) => i.video === "V11")?.packagingComments.map((c) => c.comment), ["shorter title, please"]);
  assert.deepEqual(after.items.find((i) => i.video === "V10")?.packagingComments.map((c) => c.comment), ["shorter title, please", "gate off: still fine"], "newest first");
  // approve / return of an uploaded package is still refused
  await refusedWith(h.service.decide(CH, { manifestSha256: "c".repeat(64), kind: "approved" }), "package_review_uploaded");
  await refusedWith(h.service.decide(CH, { manifestSha256: "c".repeat(64), kind: "returned", comment: "x" }), "package_review_uploaded");
  const state = await h.service.ownerReviewState(CH);
  assert.equal(state.decisions.some((d) => d.kind === "packaging_comment"), false, "a comment is never a gate decision");
});

test("AC-MG-09: a BL-257 decision (no media key) counts for its own manifest; after a re-package of the same mp4 the package is pending once, and a new approval survives later re-packages", async () => {
  const legacy: PackageReviewDecision = { id: "pr_old", manifestSha256: MANIFEST, video: "V11", thumbnailSha256: THUMB_SHA, kind: "approved", comment: null, by: "owner", device: "Mac", at: "2026-11-14T12:00:00.000Z", seq: 1 };
  const h = harness();
  await h.service.setRequired(CH, { required: true });
  h.seed(legacy);
  assert.equal((await h.service.view(CH)).items[0].state, "approved", "ready as today (no thumbnail hash is compared any more)");
  const repackaged = harness({ packages: [pkg({ manifestSha256: "e".repeat(64), title: "retitled" })] });
  await repackaged.service.setRequired(CH, { required: true });
  repackaged.seed(legacy);
  assert.equal((await repackaged.service.view(CH)).items[0].state, "pending", "one re-approval at the first re-package");
  const { decision } = await repackaged.service.decide(CH, { manifestSha256: "e".repeat(64), kind: "approved" });
  const again = harness({ packages: [pkg({ manifestSha256: "f".repeat(64), title: "third title" })] });
  await again.service.setRequired(CH, { required: true });
  again.seed(legacy);
  again.seed(decision);
  assert.equal((await again.service.view(CH)).items[0].state, "approved");
});

test("AC-PR-06: an uploaded package cannot be decided; it is listed (as uploaded) only once decided", async () => {
  const h = harness({ packages: [pkg({ uploaded: true })] });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" }), "package_review_uploaded");
  assert.deepEqual((await h.service.view(CH)).items, []);
});

test("a decision on a manifest that is not a package of this channel is refused (channel scoping)", async () => {
  const h = harness();
  await refusedWith(h.service.decide(CH, { manifestSha256: "c".repeat(64), kind: "approved" }), "package_review_not_found");
  await refusedWith(h.service.decide("UC_other", { manifestSha256: MANIFEST, kind: "approved" }), "package_review_not_found");
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", extra: 1 }), "validation_failed");
});

test("the switch is recorded with its time and device, drops the plan cache, and the view shows it; pending first", async () => {
  const h = harness({ packages: [pkg({ manifestSha256: "b".repeat(64), video: "V10" }), pkg()] });
  await h.service.decide(CH, { manifestSha256: "b".repeat(64), kind: "returned", comment: "redo" });
  const view = await h.service.setRequired(CH, { required: true });
  assert.deepEqual([view.required, view.requiredUpdatedAt, view.readable], [true, "2026-11-15T12:00:00.000Z", true]);
  assert.deepEqual(view.items.map((i) => [i.video, i.state]), [["V11", "pending"], ["V10", "returned"]]);
  assert.equal(view.waiting, 1);
  assert.deepEqual(h.afterChange, [CH, CH]);
});

test("AC-PR-07: an unreadable document: the view says so and the gate state is required with nothing approved", async () => {
  const h = harness({ unreadable: true });
  const view = await h.service.view(CH);
  assert.deepEqual([view.required, view.readable, view.items[0].state], [true, false, "pending"]);
  const state = await h.service.ownerReviewState(CH);
  assert.deepEqual([state.required, state.decisions.length], [true, 0]);
});

test("AC-PR-09: the media are only the package's own files, by its manifest hash, in this channel", async () => {
  const h = harness();
  assert.deepEqual(await h.service.mediaFile(CH, MANIFEST, "video"), { path: `/ws/${FOLDER}/V11.mp4`, bytes: 1000, type: "video/mp4" });
  assert.deepEqual(await h.service.mediaFile(CH, MANIFEST, "thumbnail"), { path: `/ws/${FOLDER}/Thumbnail_V11.jpg`, bytes: 1000, type: "image/jpeg" });
  assert.equal(await h.service.mediaFile("UC_other", MANIFEST, "video"), null);
  assert.equal(await h.service.mediaFile(CH, "c".repeat(64), "video"), null);
  assert.equal(await h.service.mediaFile(CH, "../../etc/passwd", "video"), null);
  assert.equal(await h.service.mediaFile(CH, null, "video"), null);
});

test("uploaded packages are listed only when decided, at most the 10 latest by the scan's order (planned date)", async () => {
  const packages = Array.from({ length: 12 }, (_, i) => pkg({ manifestSha256: i.toString(16).padStart(64, "0"), video: `V${i + 1}` }));
  const h = harness({ packages });
  for (const p of packages.slice(0, 11)) await h.service.decide(CH, { manifestSha256: p.manifestSha256, kind: "returned", comment: "x" });
  // all twelve uploaded since; V12 was never decided
  packages.forEach((p, i) => (packages[i] = { ...p, uploaded: true }));
  const view = await h.service.view(CH);
  assert.deepEqual(view.items.map((i) => [i.video, i.state]), ["V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11"].map((v) => [v, "uploaded"]));
});

test("review M2: with the gate off nothing waits for the owner (no badge), the packages stay listed", async () => {
  const h = harness();
  const off = await h.service.view(CH);
  assert.deepEqual([off.required, off.waiting, off.items.map((i) => i.state)], [false, 0, ["pending"]]);
  const on = await h.service.setRequired(CH, { required: true });
  assert.deepEqual([on.required, on.waiting], [true, 1]);
});

// -- Owner TG 4584 (BL-263 fix; ADR 0070 amendment), adapted by BL-265 (ADR 0072 §1): a local recode V11 → S11 rewrites the manifest (a
// new SHA-256) but not the mp4 or the thumbnail bytes. A BL-257 decision (keyed by the manifest alone -- the 11 WWE decisions in the
// live document are of this shape) is still copied to the new manifest with its kind, comment, thumbnail hash, device and ORIGINAL
// time, `carriedFrom` the old SHA-256: the alias cannot save it (it has no media key). A decision made by BL-265 names the mp4 and
// needs no copy: the gate follows the V → S recode alias. Expected values are written by hand.
const NEW_MANIFEST = "d".repeat(64);
const S_FOLDER = "04 Videos/11 November/1115 S11 Short";
const recoded = (): ReviewPackage =>
  pkg({ manifestSha256: NEW_MANIFEST, manifestPath: `${S_FOLDER}/S11_release.json`, video: "S11", videoPath: `${S_FOLDER}/S11.mp4`, thumbnailPath: `${S_FOLDER}/Thumbnail_S11.jpg` });

/** A decision as a BL-257 build wrote it: no videoSha256 / videoSizeBytes. */
const legacyDecision = (id: string, kind: "approved" | "returned", at: string, seq: number, comment: string | null = null): PackageReviewDecision => ({
  id,
  manifestSha256: MANIFEST,
  video: "V11",
  thumbnailSha256: THUMB_SHA,
  kind,
  comment,
  by: "owner",
  device: "Mac",
  at,
  seq,
});

function recodeHarness(aliases?: Map<string, string>) {
  let now = new Date("2026-11-15T12:00:00.000Z");
  const packages = [pkg()];
  const h = harness({
    packages,
    now: () => now,
    files: [`${FOLDER}/V11.mp4`, `${FOLDER}/Thumbnail_V11.jpg`, `${S_FOLDER}/S11.mp4`, `${S_FOLDER}/Thumbnail_S11.jpg`],
    // The same bytes under the new names.
    hashes: { [`/ws/${S_FOLDER}/S11.mp4`]: VIDEO_SHA, [`/ws/${S_FOLDER}/Thumbnail_S11.jpg`]: THUMB_SHA },
    ...(aliases ? { aliases } : {}),
  });
  const recode = () => {
    packages[0] = recoded();
  };
  return { ...h, packages, recode, later: () => (now = new Date("2026-11-16T09:30:00.000Z")) };
}

test("TG 4584 (legacy decision): an approval is carried to the recoded manifest with its original time and thumbnail hash; the gate and the screen read it approved", async () => {
  const h = recodeHarness();
  await h.service.setRequired(CH, { required: true });
  h.seed(legacyDecision("pr_old1", "approved", "2026-11-15T12:00:00.000Z", 1));
  h.later();
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "approved", wrote: true });
  const copy = h.decisions().find((d) => d.manifestSha256 === NEW_MANIFEST);
  assert.deepEqual(copy, { id: "pr_id1", manifestSha256: NEW_MANIFEST, video: "S11", thumbnailSha256: THUMB_SHA, kind: "approved", comment: null, by: "owner", device: "Mac", at: "2026-11-15T12:00:00.000Z", carriedFrom: MANIFEST });
  h.recode();
  const view = await h.service.view(CH);
  assert.deepEqual([view.items[0].video, view.items[0].state, view.items[0].decidedAt, view.waiting], ["S11", "approved", "2026-11-15T12:00:00.000Z", 0]);
  const state = await h.service.ownerReviewState(CH);
  const key = { manifestSha256: NEW_MANIFEST, video: "S11", videoSha256: VIDEO_SHA, videoSizeBytes: 1000 };
  assert.equal(ownerReviewProblemOf(state, key), null, "the scan's gate: ready");
  // AC-PR-11 keeps comparing with the approval's own time: a cancelled row made before 12:00 is excused, one made after is not.
  const rows = (createdAt: string) => [{ manifestSha256: NEW_MANIFEST, status: "cancelled", videoId: null, createdAtMs: Date.parse(createdAt) }];
  assert.deepEqual([...triedExceptionsOf(state, rows("2026-11-15T11:00:00.000Z"))], [NEW_MANIFEST]);
  assert.deepEqual([...triedExceptionsOf(state, rows("2026-11-15T13:00:00.000Z"))], []);
});

test("TG 4584 (legacy decision): a return is carried with its comment -- the latest decision only (approved, then returned → returned)", async () => {
  const h = recodeHarness();
  h.seed(legacyDecision("pr_old1", "approved", "2026-11-15T12:00:00.000Z", 1));
  h.seed(legacyDecision("pr_old2", "returned", "2026-11-16T09:30:00.000Z", 2, "the intro is cut"));
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "returned", wrote: true });
  h.recode();
  const item = (await h.service.view(CH)).items[0];
  assert.deepEqual([item.video, item.state, item.comment, item.decidedAt], ["S11", "returned", "the intro is cut", "2026-11-16T09:30:00.000Z"]);
});

test("TG 4584: no decision carries nothing; a retry writes no second copy; bad input or an unreadable document throws and writes nothing", async () => {
  const h = recodeHarness();
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: null, wrote: false });
  assert.deepEqual(h.decisions(), []);
  h.seed(legacyDecision("pr_old1", "returned", "2026-11-15T12:00:00.000Z", 1, "redo"));
  await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" });
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "returned", wrote: false });
  assert.equal(h.decisions().filter((d) => d.manifestSha256 === NEW_MANIFEST).length, 1);
  await assert.rejects(h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: MANIFEST, video: "S11" }));
  await assert.rejects(h.service.carryDecision(CH, { fromSha256: "../x", toSha256: NEW_MANIFEST, video: "S11" }));
  await assert.rejects(h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "" }));
  assert.equal(h.decisions().length, 2);
  const unreadable = harness({ unreadable: true });
  await assert.rejects(unreadable.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }));
  assert.deepEqual(unreadable.decisions(), []);
});

test("TG 4584 (review fix, legacy decision): a return made on the old manifest after the first carry is carried by the second one and stands on the new manifest", async () => {
  const h = recodeHarness();
  h.seed(legacyDecision("pr_old1", "approved", "2026-11-15T12:00:00.000Z", 1));
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "approved", wrote: true });
  h.seed(legacyDecision("pr_old2", "returned", "2026-11-16T09:30:00.000Z", 3, "cut the outro"));
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "returned", wrote: true });
  const latest = latestOwnerDecision(NEW_MANIFEST, h.decisions());
  assert.deepEqual([latest?.kind, latest?.comment, latest?.at, latest?.carriedFrom], ["returned", "cut the outro", "2026-11-16T09:30:00.000Z", MANIFEST]);
  h.recode();
  assert.deepEqual([(await h.service.view(CH)).items[0].state], ["returned"]);
});

test("AC-MG-08 / ADR 0072 §1 (BL-265): a media decision is NOT copied by the recode; the recoded S package reads approved through the V → S alias, and not without it", async () => {
  const h = recodeHarness(new Map([["V11", "S11"]]));
  await h.service.setRequired(CH, { required: true });
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.deepEqual(await h.service.carryDecision(CH, { fromSha256: MANIFEST, toSha256: NEW_MANIFEST, video: "S11" }), { carried: "approved", wrote: false });
  assert.equal(h.decisions().length, 1, "nothing copied");
  h.recode();
  const view = await h.service.view(CH);
  assert.deepEqual([view.items[0].video, view.items[0].state, view.waiting], ["S11", "approved", 0]);
  const state = await h.service.ownerReviewState(CH);
  const key = { manifestSha256: NEW_MANIFEST, video: "S11", videoSha256: VIDEO_SHA, videoSizeBytes: 1000 };
  assert.equal(ownerReviewProblemOf(state, key), null);
  // the tried rule follows the alias too: a cancelled S11 row made before the approval is excused
  const tried = triedKeysOf(state, [{ manifestSha256: NEW_MANIFEST, video: "S11", videoSha256: VIDEO_SHA, sizeBytes: 1000, status: "cancelled", videoId: null, createdAtMs: Date.parse("2026-11-15T11:00:00.000Z") }]);
  assert.deepEqual(tried.media, []);
  // no alias known (another channel's V11, or the video list unreadable): the S package is pending (fail closed)
  const noAlias = recodeHarness();
  await noAlias.service.setRequired(CH, { required: true });
  await noAlias.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  noAlias.recode();
  assert.equal((await noAlias.service.view(CH)).items[0].state, "pending");
});

test("TG 4584: the owner's surface has no carry (only the recode's composition reaches it)", () => {
  const h = harness();
  assert.equal("carryDecision" in packageReviewsOwnerSurface(h.service), false);
});

// Fix (owner report 2026-11-24, WWE V31/V32): the packages waiting for the owner reach the Media menu badge and the bell. Expected
// from ADR 0070 §2/§4 and the screen's own rule (review M2): a pending package of a gated channel waits (1); the owner's approval or
// return ends the wait (0); with the gate off nothing waits -- and then the packages are not even scanned (the poll asks every channel).
test("waiting: one pending package of a gated channel is 1; after the owner's approval it is 0", async () => {
  const h = harness();
  await h.service.setRequired(CH, { required: true });
  assert.equal(await h.service.waiting(CH), 1);
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.equal(await h.service.waiting(CH), 0);
});

test("waiting: after the owner's return it is 0 (a returned package waits for the factory, not for him)", async () => {
  const h = harness();
  await h.service.setRequired(CH, { required: true });
  assert.equal(await h.service.waiting(CH), 1);
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", comment: "the intro is cut" });
  assert.equal(await h.service.waiting(CH), 0);
});

test("waiting: a channel without the gate is 0 and its packages are never scanned; an unreadable document holds every package", async () => {
  const off = harness();
  assert.equal(await off.service.waiting(CH), 0);
  assert.deepEqual(off.scans, []);
  const unreadable = harness({ unreadable: true });
  assert.equal(await unreadable.service.waiting(CH), 1);
  const uploaded = harness({ packages: [pkg({ uploaded: true })] });
  await uploaded.service.setRequired(CH, { required: true });
  assert.equal(await uploaded.service.waiting(CH), 0, "an uploaded package waits for nobody");
  assert.equal(typeof packageReviewsOwnerSurface(off.service).waiting, "function", "the owner's routes reach the count");
});
