import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { decidingImageRecordOf } from "@/lib/image-reviews";
import { isDomainError } from "@/lib/shared-domain";
import type { ClipReviewsSnapshot, ImageReviewDecision, ImageReviewImage, ImageReviewsSnapshot } from "@/lib/sync-gateway";
import type { ClipReviewsPorts } from "./contracts";
import { createClipReviewsService } from "./services";

// BL-272 (ADR 0076; coordinator brief item 4): `producer_clip_review_submit` takes an optional `approvedImageId` -- the approved
// master still of the SAME channel the clip was made from. Expected by hand from the brief: an approved or approved-with-note image
// is accepted and shown with the clip; a pending, returned or withdrawn one, an unknown one or another channel's is refused and
// stores nothing; a clip without it carries no such key (the clip views of BL-241 are unchanged).

const A = "UC_clip_A";
const B = "UC_clip_B";
const WS = "/Volumes/T9/YouTube/01 Tropico Jazz";
const CLIP = "03 Images/Scenes/P46/preview_30s.mp4";

const image = (imageId: string, channelId: string): ImageReviewImage => ({
  imageId,
  channelId,
  sceneId: "P46",
  imagePath: "03 Images/Scenes/P46/master.png",
  note: "",
  batchId: "b-1",
  requestId: null,
  width: 1920,
  height: 1080,
  sizeBytes: 10,
  sha256: "c".repeat(64),
  submittedAt: "2026-11-23T09:00:00.000Z",
  submittedBy: "tok",
  device: "Mac",
});
const decision = (id: string, imageId: string, kind: ImageReviewDecision["kind"], comment: string | null = null): ImageReviewDecision => ({
  id,
  imageId,
  kind,
  by: kind === "withdrawn" ? "producer" : "owner",
  comment,
  device: "Mac",
  at: "2026-11-23T09:30:00.000Z",
});

/** Image reviews of two channels: A has one image in every state, B has its own approved image. */
const imageDocs: Record<string, ImageReviewsSnapshot> = {
  [A]: {
    images: { img_ok: image("img_ok", A), img_note: image("img_note", A), img_ret: image("img_ret", A), img_wd: image("img_wd", A), img_wait: image("img_wait", A) },
    decisions: {
      d1: decision("d1", "img_ok", "approved"),
      d2: decision("d2", "img_note", "approved_with_note", "убрать прохожего"),
      d3: decision("d3", "img_ret", "returned", "темно"),
      d4: decision("d4", "img_wd", "withdrawn"),
    },
  },
  [B]: { images: { img_b: image("img_b", B) }, decisions: { d5: decision("d5", "img_b", "approved") } },
};

/** The port as the module's index wires it: the channel's own document and the derived status. */
async function imageOf(channelId: string, imageId: string) {
  const doc = imageDocs[channelId] ?? { images: {}, decisions: {} };
  const found = Object.hasOwn(doc.images, imageId) ? doc.images[imageId] : undefined;
  if (!found || found.channelId !== channelId) return null;
  const record = decidingImageRecordOf(imageId, Object.values(doc.decisions));
  return { imageId, sceneId: found.sceneId, imagePath: found.imagePath, status: record ? record.kind : "pending" };
}

function setup(withPort = true) {
  const docs = new Map<string, ClipReviewsSnapshot>();
  const doc = (channelId: string) => docs.get(channelId) ?? (docs.set(channelId, { clips: {}, decisions: {} }), docs.get(channelId)!);
  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  let n = 0;
  const ports: ClipReviewsPorts = {
    store: {
      read: async (channelId) => JSON.parse(JSON.stringify(doc(channelId))),
      addClip: async (channelId, clip) => void (doc(channelId).clips[clip.clipId] = clip),
      addDecision: async (channelId, d) => void (doc(channelId).decisions[d.id] = d),
    },
    isChannelConnected: async () => true,
    workspace: async () => WS,
    resolveFile: async (workspace, relativePath) => (relativePath === CLIP ? { ok: true, path: path.posix.join(workspace, relativePath), bytes: 1000 } : { ok: false, reason: "missing" }),
    probeDurationSeconds: async () => 30,
    hashFile: async () => "d".repeat(64),
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => new Date("2026-11-23T10:00:00.000Z"),
    randomId: () => `r${++n}`,
    withLock: (fn) => fn(),
    audit: async () => undefined,
    logError: () => undefined,
    staging: { create: unused, get: unused, list: unused, append: unused, head: unused, readAll: unused, hash: unused, remove: unused, removeOlderThan: unused },
    attachmentFiles: { write: unused, remove: unused, resolve: unused },
    ...(withPort ? { imageOf } : {}),
  };
  return { service: createClipReviewsService(ports), stored: (channelId: string) => Object.values(doc(channelId).clips) };
}

const submit = (approvedImageId?: string) => ({ channelId: A, sceneId: "P46", clipPath: CLIP, note: "30 s loop", ...(approvedImageId ? { approvedImageId } : {}) });
const producer = { tokenId: "tok" };
async function refused(promise: Promise<unknown>, code: string, status?: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code && (status === undefined || (error.details as { status?: string }).status === status));
}

test("BL-272: a clip from an approved image (with or without a note) is accepted and shows that image to the owner", async () => {
  for (const imageId of ["img_ok", "img_note"]) {
    const { service } = setup();
    const { clip } = await service.submit(submit(imageId), producer);
    assert.equal(clip.approvedImageId, imageId);
    assert.equal((await service.get({ channelId: A, clipId: clip.clipId })).clip.approvedImageId, imageId);
    const owner = (await service.ownerList(A)).clips[0];
    assert.deepEqual(owner.approvedImage, { imageId, sceneId: "P46", imagePath: "03 Images/Scenes/P46/master.png", status: imageId === "img_ok" ? "approved" : "approved_with_note" });
  }
});

test("BL-272: a clip naming a pending, returned or withdrawn image is refused and nothing is stored", async () => {
  const { service, stored } = setup();
  await refused(service.submit(submit("img_ret"), producer), "clip_review_image_not_approved", "returned");
  await refused(service.submit(submit("img_wait"), producer), "clip_review_image_not_approved", "pending");
  await refused(service.submit(submit("img_wd"), producer), "clip_review_image_not_approved", "withdrawn");
  assert.deepEqual(stored(A), []);
});

test("BL-272: another channel's image, an unknown id, or no image reviews here is refused", async () => {
  const { service, stored } = setup();
  await refused(service.submit(submit("img_b"), producer), "clip_review_image_not_found");
  await refused(service.submit(submit("img_none"), producer), "clip_review_image_not_found");
  await refused(service.submit({ ...submit(), approvedImageId: "../img" }, producer), "validation_failed");
  assert.deepEqual(stored(A), []);
  await refused(setup(false).service.submit(submit("img_ok"), producer), "clip_review_image_not_found");
});

test("BL-272: a clip without approvedImageId carries no such key, for the Producer and the owner", async () => {
  const { service } = setup();
  const { clip } = await service.submit(submit(), producer);
  assert.equal("approvedImageId" in clip, false);
  assert.equal("approvedImage" in (await service.ownerList(A)).clips[0], false);
});
