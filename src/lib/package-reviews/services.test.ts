import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type PackageReviewDecision, type PackageReviewRequired, type PackageReviewsSnapshot, type ReviewPackage } from "./contracts";
import { createPackageReviewsService, type PackageReviewsDeps } from "./services";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-03/04/05/06/07/09/10; ADR 0070 §3-§4, §6). The expected values come from the plan: an
// approval needs the manifest's video sha256 and this computer's mp4 hashing to it, and records the thumbnail file's hash; a return
// needs a comment; an uploaded package is not reviewed; a decision drops the plan's cache once; the media are only the package's own.

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
    uploaded: false,
    otherProblems: [],
    ...over,
  };
}

function harness(options: { packages?: ReviewPackage[]; hashes?: Record<string, string>; files?: string[]; unreadable?: boolean } = {}) {
  let required: PackageReviewRequired | null = null;
  const decisions: Record<string, PackageReviewDecision> = {};
  let exists = false;
  const afterChange: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const hashed: string[] = [];
  const files = new Set(options.files ?? [`${FOLDER}/V11.mp4`, `${FOLDER}/Thumbnail_V11.jpg`]);
  const hashes: Record<string, string> = { [`/ws/${FOLDER}/V11.mp4`]: VIDEO_SHA, [`/ws/${FOLDER}/Thumbnail_V11.jpg`]: THUMB_SHA, ...(options.hashes ?? {}) };
  let n = 0;
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
    packages: async (channelId) => (channelId === CH ? { status: "ok", packages: options.packages ?? [pkg()] } : { status: "ok", packages: [] }),
    resolveFile: async (channelId, rel) => (channelId === CH && files.has(rel) ? { path: `/ws/${rel}`, bytes: 1000 } : null),
    hashFile: async (abs) => {
      hashed.push(abs);
      return hashes[abs] ?? "0".repeat(64);
    },
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (e) => void audits.push(e),
    afterChange: (channelId) => void afterChange.push(channelId),
  };
  return { service: createPackageReviewsService(deps), hashes, afterChange, audits, hashed, decisions: () => Object.values(decisions) };
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

test("AC-PR-03/05: an approval records the manifest and the thumbnail file's hash at decision time; the plan cache is dropped once (AC-PR-10)", async () => {
  const h = harness();
  const { decision, view } = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.deepEqual(decision, { id: "pr_id1", manifestSha256: MANIFEST, video: "V11", thumbnailSha256: THUMB_SHA, kind: "approved", comment: null, by: "owner", device: "Mac", at: "2026-11-15T12:00:00.000Z" });
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

test("AC-PR-03: after approval, a changed thumbnail file reads pending again in the owner's list", async () => {
  const h = harness();
  // review M2 (changed requirement): only a channel with the gate on counts packages as waiting, so the gate is switched on here.
  await h.service.setRequired(CH, { required: true });
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  h.hashes[`/ws/${FOLDER}/Thumbnail_V11.jpg`] = "9".repeat(64);
  const view = await h.service.view(CH);
  assert.deepEqual([view.items[0].state, view.waiting], ["pending", 1]);
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
  assert.deepEqual([state.required, state.approved.size, state.returned.size], [true, 0, 0]);
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
