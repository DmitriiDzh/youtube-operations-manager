import assert from "node:assert/strict";
import test from "node:test";
import { activeUploadsByVideo, unslottedVideos, uploadPercent, uploadQueueSummary, type PlanUploadRef } from "./plan-extras-model";

// BL-266 (owner TG 4730/4732): «План» shows «Без слота: N» -- the videos in work no package puts on a plan slot -- and this channel's
// uploads (a percent on the slot card, one queue line). Expected values written by hand from that requirement.

test("BL-266: «Без слота» is 0 with no projects, and 0 when every number in work has a package naming a slot", () => {
  assert.deepEqual(unslottedVideos([], []), []);
  assert.deepEqual(
    unslottedVideos([{ video: "V10", state: "packaged", hasVideoFile: true }], [{ video: "V10", pkg: { slotId: "s1" } }]),
    []
  );
});

test("BL-266: «Без слота» counts one number in work without a slot", () => {
  assert.deepEqual(unslottedVideos([{ video: "V11", state: "in_work", hasVideoFile: false }], []), ["V11"]);
});

test("BL-266: «Без слота» counts N numbers in preparation, editing and packaged-without-slot; never one on YouTube, published or cancelled", () => {
  const projects = [
    { video: "V20", state: "in_work" as const, hasVideoFile: false }, // preparation, no package: counted
    { video: "V21", state: "in_work" as const, hasVideoFile: true }, // editing: counted
    { video: "V22", state: "packaged" as const, hasVideoFile: true }, // package without a slot: counted
    { video: "V23", state: "packaged" as const, hasVideoFile: true }, // package naming a slot: not counted
    { video: "V24", state: "packaged" as const, youtubeVideoId: "abcdefghijk" }, // already on YouTube: not counted
    { video: "V25", state: "published" as const }, // published: not counted
    { video: "V26", state: "cancelled" as const, hasVideoFile: true }, // cancelled: not counted
    { video: "V27", state: "recoded" as const }, // moved to an S code: not counted
  ];
  const packages = [
    { video: "V22", pkg: { slotId: null } },
    { video: "V23", pkg: { slotId: "slot-7" } },
    { video: null, pkg: { slotId: "slot-9" } }, // a package without a number names no project
    { video: "V20", pkg: null }, // an unreadable package names no slot
  ];
  assert.deepEqual(unslottedVideos(projects, packages), ["V20", "V21", "V22"]);
});

test("BL-266: the upload percent is the stored share, rounded down, 0 when the size is unknown", () => {
  assert.equal(uploadPercent({ totalBytes: 1000, storedBytes: 415 }), 41);
  assert.equal(uploadPercent({ totalBytes: 0, storedBytes: 0 }), 0);
  assert.equal(uploadPercent({ totalBytes: 1000, storedBytes: 1000 }), 100);
});

const row = (video: string, status: PlanUploadRef["status"], stored = 0, extra: Partial<PlanUploadRef> = {}): PlanUploadRef => ({ video, status, totalBytes: 100, storedBytes: stored, ...extra });

test("BL-266: the slot card gets a chip only for an upload not over yet; done, failed and cancelled rows give none", () => {
  const map = activeUploadsByVideo([row("V63", "uploading", 41), row("V64", "queued"), row("V60", "done", 100), row("V61", "failed"), row("V62", "cancelled")]);
  assert.deepEqual([...map.keys()].sort(), ["V63", "V64"]);
  assert.deepEqual(map.get("V63"), { status: "uploading", percent: 41 });
  assert.deepEqual(map.get("V64"), { status: "queued", percent: 0 });
});

test("BL-266: the queue line counts this channel's uploads not over yet and names the one being sent with its percent", () => {
  assert.deepEqual(uploadQueueSummary([]), { active: 0, current: null, needsDecision: 0 });
  const summary = uploadQueueSummary([row("V65", "queued", 0, { queuePosition: 2 }), row("V63", "uploading", 41), row("V60", "done", 100), row("V59", "failed", 0, { errorCode: "unknown_outcome" }), row("V58", "failed", 0, { errorCode: "processing_failed" })]);
  assert.deepEqual(summary, { active: 2, current: { video: "V63", status: "uploading", percent: 41 }, needsDecision: 1 });
  // Nothing sending: the next in the queue is named.
  assert.deepEqual(uploadQueueSummary([row("V66", "queued", 0, { queuePosition: 3 }), row("V65", "queued", 0, { queuePosition: 1 })]).current, { video: "V65", status: "queued", percent: 0 });
});

test("BL-266 review: a package whose video was deleted on YouTube holds no slot -- its number counts as without a slot", () => {
  // BL-243 (markSharedSlots): a package in `deleted_on_youtube` holds no slot. V30 is packaged again (not on YouTube any more).
  assert.deepEqual(unslottedVideos([{ video: "V30", state: "packaged", hasVideoFile: true }], [{ video: "V30", pkg: { slotId: "s3" }, state: "deleted_on_youtube", problems: [] }]), ["V30"]);
});

test("BL-266 review: two packages naming one slot -- after one is uploaded the other holds none; before, both still claim it", () => {
  const projects = [
    { video: "V40", state: "packaged" as const, hasVideoFile: true },
    { video: "V41", state: "packaged" as const, hasVideoFile: true },
  ];
  // V39 (uploaded, not a project in work here) took slot s4: V40 is marked `slot_taken` and holds no slot; V41 names its own slot.
  assert.deepEqual(
    unslottedVideos(projects, [
      { video: "V39", pkg: { slotId: "s4" }, state: "scheduled", problems: [] },
      { video: "V40", pkg: { slotId: "s4" }, state: "not_ready", problems: [{ code: "slot_taken" }] },
      { video: "V41", pkg: { slotId: "s5" }, state: "ready", problems: [] },
    ]),
    ["V40"]
  );
  // Neither uploaded: both are `slot_duplicate` and both still claim s6 (nothing counted without a slot).
  assert.deepEqual(
    unslottedVideos(projects, [
      { video: "V40", pkg: { slotId: "s6" }, state: "not_ready", problems: [{ code: "slot_duplicate" }] },
      { video: "V41", pkg: { slotId: "s6" }, state: "not_ready", problems: [{ code: "slot_duplicate" }] },
    ]),
    []
  );
});
