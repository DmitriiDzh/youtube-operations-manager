import assert from "node:assert/strict";
import test from "node:test";
import { answerReady, batchesOf, canApprove, fullSrcOf, previewSrcOf, versionsOf, viewerKeyAction, VIEWER_SCROLL_STEP, type ImageDto } from "./image-reviews-model";

// BL-272 (ADR 0076; coordinator brief item 2): a batch is shown as one grid -- the images sharing a batchId, in the order the Producer
// sent them; batches with something waiting come first, newest first, then the answered ones; the images sent without a batch form
// one group. Expected values by hand.

const img = (imageId: string, over: Partial<ImageDto> = {}): ImageDto => ({
  imageId,
  channelId: "UC_a",
  sceneId: imageId.toUpperCase(),
  imagePath: `03 Images/${imageId}.png`,
  note: "",
  batchId: "b1",
  requestId: null,
  width: 1920,
  height: 1080,
  sizeBytes: 1,
  sha256: "abcdef0123456789".repeat(4),
  submittedAt: "2026-11-23T10:00:00Z",
  device: "Mac",
  status: "pending",
  comment: null,
  decidedAt: null,
  decidedOn: null,
  file: "ok",
  ...over,
});

test("BL-272: images form one grid per batch, in the order sent; waiting batches first (newest first), then answered; no batch is one group", () => {
  const images = [
    img("c", { batchId: "b1", submittedAt: "2026-11-23T10:02:00Z" }),
    img("a", { batchId: "b1", submittedAt: "2026-11-23T10:00:00Z" }),
    img("b", { batchId: "b1", submittedAt: "2026-11-23T10:01:00Z", status: "approved" }),
    img("x", { batchId: "old", submittedAt: "2026-11-20T09:00:00Z", status: "returned" }),
    img("y", { batchId: "b2", submittedAt: "2026-11-23T12:00:00Z" }),
    img("s", { batchId: null, submittedAt: "2026-11-22T08:00:00Z", status: "approved_with_note" }),
  ];
  const batches = batchesOf(images);
  assert.deepEqual(
    batches.map((b) => [b.key, b.batchId, b.images.map((i) => i.imageId), b.waiting]),
    [
      ["b:b2", "b2", ["y"], 1],
      ["b:b1", "b1", ["a", "b", "c"], 2],
      ["single", null, ["s"], 0],
      ["b:old", "old", ["x"], 0],
    ]
  );
  assert.deepEqual(batchesOf([]), []);
});

test("BL-272: a reworked image of the same scene is the next version", () => {
  const versions = versionsOf([img("p46b", { sceneId: "P46", submittedAt: "2026-11-23T11:00:00Z" }), img("p46a", { sceneId: "P46" }), img("p47", { sceneId: "P47" })]);
  assert.deepEqual([versions.get("p46a"), versions.get("p46b"), versions.get("p47")], [1, 2, 1]);
});

test("BL-272: approving needs a waiting image whose copy here is the sent file; a note-approval and a return need words", () => {
  assert.equal(canApprove({ status: "pending", file: "ok" }), true);
  assert.equal(canApprove({ status: "pending", file: "changed" }), false);
  assert.equal(canApprove({ status: "pending", file: "missing" }), false);
  assert.equal(canApprove({ status: "approved", file: "ok" }), false);
  assert.equal(answerReady("approve", ""), true);
  assert.equal(answerReady("approve_with_note", "   "), false);
  assert.equal(answerReady("approve_with_note", "убрать прохожего"), true);
  assert.equal(answerReady("return", ""), false);
  assert.equal(answerReady("return", "темно"), true);
});

test("BL-272: the preview and full image addresses name the image and its file version", () => {
  const image = img("img_1");
  assert.equal(previewSrcOf("/api/channels/UC_a/image-reviews", image), "/api/channels/UC_a/image-reviews/img_1/preview?v=abcdef012345");
  assert.equal(fullSrcOf("/api/channels/UC_a/image-reviews", image), "/api/channels/UC_a/image-reviews/img_1/image?v=abcdef012345");
});

// Review (item 5): the viewer's keys, by hand from the brief -- Esc while typing or with a confirmation open cancels only the
// confirmation (never closes the viewer, and not while saving); in the 100 % view the arrows scroll the image and PageUp / PageDown
// switch stills; in the fitted view ← / → and PageUp / PageDown switch.
test("BL-272 (review): Esc cancels only an open confirmation or the typing in it; otherwise it closes the viewer", () => {
  const key = (k: string, over: Partial<Parameters<typeof viewerKeyAction>[0]> = {}) => viewerKeyAction({ key: k, typing: false, confirming: false, saving: false, actual: false, ...over });
  assert.deepEqual(key("Escape"), { type: "close" });
  assert.deepEqual(key("Escape", { confirming: true }), { type: "cancel_confirm" });
  assert.deepEqual(key("Escape", { typing: true }), { type: "cancel_confirm" });
  assert.deepEqual(key("Escape", { typing: true, confirming: true, actual: true }), { type: "cancel_confirm" });
  assert.equal(key("Escape", { confirming: true, saving: true }), null);
  assert.deepEqual(key("Escape", { saving: true }), { type: "close" });
});

test("BL-272 (review): fitted view -- ← / → and PageUp / PageDown switch stills; typing keeps every key", () => {
  const key = (k: string, typing = false) => viewerKeyAction({ key: k, typing, confirming: false, saving: false, actual: false });
  assert.deepEqual(key("ArrowLeft"), { type: "move", step: -1 });
  assert.deepEqual(key("ArrowRight"), { type: "move", step: 1 });
  assert.deepEqual(key("PageUp"), { type: "move", step: -1 });
  assert.deepEqual(key("PageDown"), { type: "move", step: 1 });
  assert.equal(key("ArrowUp"), null);
  assert.equal(key("a"), null);
  for (const k of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"]) assert.equal(key(k, true), null);
});

test("BL-272 (review): 100 % view -- the arrows scroll the image, PageUp / PageDown switch stills", () => {
  const key = (k: string) => viewerKeyAction({ key: k, typing: false, confirming: false, saving: false, actual: true });
  assert.equal(VIEWER_SCROLL_STEP, 80);
  assert.deepEqual(key("ArrowLeft"), { type: "scroll", dx: -80, dy: 0 });
  assert.deepEqual(key("ArrowRight"), { type: "scroll", dx: 80, dy: 0 });
  assert.deepEqual(key("ArrowUp"), { type: "scroll", dx: 0, dy: -80 });
  assert.deepEqual(key("ArrowDown"), { type: "scroll", dx: 0, dy: 80 });
  assert.deepEqual(key("PageUp"), { type: "move", step: -1 });
  assert.deepEqual(key("PageDown"), { type: "move", step: 1 });
});

