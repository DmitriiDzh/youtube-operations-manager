import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { readImageInfo } from "@/lib/media-preview";
import { hashReviewFile, resolveReviewFile } from "@/lib/review-items";
import { isDomainError } from "@/lib/shared-domain";
import type { ImageReviewsSnapshot } from "@/lib/sync-gateway";
import type { ImageReviewsPorts } from "./contracts";
import { createImageReviewsService } from "./services";

// BL-272 (ADR 0076; owner TG 2547 via the Producer). Expected values are written from the requirement, by hand: a submitted image is
// pending with its size and SHA-256, the owner's three answers are approved / approved_with_note / returned with his words, a changed
// file cannot be approved, a path outside the channel's own folder is refused, a requestId makes a submit idempotent. The files are
// real (temporary folders, real PNG/JPEG made with sharp) and go through the real shared workspace rule, hash and image reader.

const A = "UC_img_A";
const B = "UC_img_B";
const SCENE_PATH = "03 Images/Scenes/P46/master.png";

async function png(width = 1920, height = 1080, color = { r: 20, g: 120, b: 60 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}
async function jpeg(width = 1920, height = 1080): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
}

function memoryStore(): ImageReviewsPorts["store"] & { snapshot(channelId: string): ImageReviewsSnapshot } {
  const docs = new Map<string, ImageReviewsSnapshot>();
  const doc = (channelId: string) => docs.get(channelId) ?? (docs.set(channelId, { images: {}, decisions: {} }), docs.get(channelId)!);
  return {
    read: async (channelId) => JSON.parse(JSON.stringify(doc(channelId))),
    addImage: async (channelId, image) => void (doc(channelId).images[image.imageId] = image),
    addDecision: async (channelId, decision) => void (doc(channelId).decisions[decision.id] = decision),
    snapshot: (channelId) => doc(channelId),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Two channels, each with its own workspace folder under one root, and a folder outside both. */
async function world(options: { device?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "image-reviews-"));
  const workspaces: Record<string, string> = { [A]: path.join(root, "01 Tropico"), [B]: path.join(root, "02 Japan") };
  const outside = path.join(root, "outside");
  for (const dir of [...Object.values(workspaces), outside]) await mkdir(dir, { recursive: true });
  const store = memoryStore();
  const audits: Array<{ channelId: string; imageId: string; detail: Record<string, unknown> }> = [];
  const nudges: number[] = [];
  const clock = { t: Date.parse("2026-11-23T10:00:00.000Z") };
  let n = 0;
  const ports: ImageReviewsPorts = {
    store,
    isChannelConnected: async (channelId) => channelId === A || channelId === B,
    workspace: async (channelId) => workspaces[channelId] ?? null,
    resolveFile: resolveReviewFile,
    probeImage: readImageInfo,
    hashFile: hashReviewFile,
    preview: async () => null,
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => options.device ?? "Mac",
    now: () => new Date(clock.t),
    randomId: () => `r${String(++n).padStart(4, "0")}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    notifyOwnerDecision: () => void nudges.push(clock.t),
  };
  async function put(channelId: string, relativePath: string, bytes: Buffer | string) {
    const file = path.join(workspaces[channelId], ...relativePath.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return file;
  }
  return { root, workspaces, outside, store, audits, nudges, clock, put, service: createImageReviewsService(ports), cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function withWorld(fn: (w: World) => Promise<void>, options: { device?: string } = {}) {
  const w = await world(options);
  try {
    await fn(w);
  } finally {
    await w.cleanup();
  }
}

const producer = { tokenId: "tok-1" };
const submitInput = (overrides: Record<string, unknown> = {}) => ({ channelId: A, sceneId: "P46", imagePath: SCENE_PATH, ...overrides });
async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("BL-272: a 1920×1080 PNG in the channel folder becomes a pending image with its size and SHA-256; get, list and withdraw", async () => {
  await withWorld(async (w) => {
    const bytes = await png();
    await w.put(A, SCENE_PATH, bytes);
    const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const { image, replayed } = await w.service.submit(submitInput({ sceneId: "  P46  ", note: "закат, без людей" }), producer);
    const expected = {
      imageId: image.imageId,
      channelId: A,
      sceneId: "P46",
      imagePath: SCENE_PATH,
      note: "закат, без людей",
      batchId: null,
      requestId: null,
      width: 1920,
      height: 1080,
      sizeBytes: bytes.length,
      sha256: sha,
      submittedAt: "2026-11-23T10:00:00.000Z",
      device: "Mac",
      status: "pending",
      comment: null,
      decidedAt: null,
      decidedOn: null,
    };
    assert.equal(replayed, false);
    assert.deepEqual(image, expected);
    assert.match(image.imageId, /^img_/);
    assert.deepEqual((await w.service.get({ channelId: A, imageId: image.imageId })).image, expected);
    assert.deepEqual(await w.service.list({ channelId: A }), { images: [expected], pending: 1 });
    assert.deepEqual(await w.service.ownerList(A), { images: [{ ...expected, file: "ok" }], waiting: 1 });

    w.clock.t += 60_000;
    const withdrawn = (await w.service.withdraw({ channelId: A, imageId: image.imageId })).image;
    assert.deepEqual([withdrawn.status, withdrawn.comment, withdrawn.decidedAt, withdrawn.decidedOn], ["withdrawn", null, "2026-11-23T10:01:00.000Z", "Mac"]);
    await refused(w.service.withdraw({ channelId: A, imageId: image.imageId }), "image_review_not_pending");
    assert.deepEqual(await w.service.list({ channelId: A, status: "pending" }), { images: [], pending: 0 });
    // A note is optional; no note reads "".
    await w.put(A, "03 Images/Scenes/P47/master.jpg", await jpeg());
    assert.equal((await w.service.submit(submitInput({ sceneId: "P47", imagePath: "03 Images/Scenes/P47/master.jpg" }), producer)).image.note, "");
    // The owner's decision is never a Producer field.
    await refused(w.service.submit(submitInput({ status: "approved" }), producer), "validation_failed");
    await refused(w.service.submit(submitInput({ comment: "ok" }), producer), "validation_failed");
  });
});

test("BL-272: the SHA-256 pins the file -- a changed file (same size) is detected, cannot be approved, and can still be returned", async () => {
  await withWorld(async (w) => {
    await w.put(A, SCENE_PATH, await png());
    const { image } = await w.service.submit(submitInput(), producer);
    // Same dimensions, same encoder settings, another colour: very likely the same length -- force it to be, byte for byte.
    const original = await png();
    const other = Buffer.from(original);
    other[other.length - 20] ^= 0xff; // one byte inside the trailing data changes; the size stays
    await w.put(A, SCENE_PATH, other);
    assert.equal((await w.service.ownerList(A)).images[0].file, "changed");
    await refused(w.service.decide(A, image.imageId, { action: "approve" }, "u1"), "image_review_file_changed");
    await refused(w.service.decide(A, image.imageId, { action: "approve_with_note", comment: "убрать прохожего" }, "u1"), "image_review_file_changed");
    assert.deepEqual(w.store.snapshot(A).decisions, {});
    const returned = (await w.service.decide(A, image.imageId, { action: "return", comment: "файл заменён, пришлите заново" }, "u1")).image;
    assert.deepEqual([returned.status, returned.comment, returned.file], ["returned", "файл заменён, пришлите заново", "changed"]);
    // A file gone from this computer cannot be approved either.
    await w.put(A, "03 Images/Scenes/P48/master.png", await png());
    const second = (await w.service.submit(submitInput({ sceneId: "P48", imagePath: "03 Images/Scenes/P48/master.png" }), producer)).image;
    await rm(path.join(w.workspaces[A], "03 Images", "Scenes", "P48", "master.png"));
    await refused(w.service.decide(A, second.imageId, { action: "approve" }, "u1"), "image_review_file_missing");
  });
});

test("BL-272 (DEVELOPMENT_PLAYBOOK §6.6): a path outside the channel's folder is refused -- .., absolute, backslashes, a symlink out", async () => {
  await withWorld(async (w) => {
    await writeFile(path.join(w.outside, "secret.png"), await png());
    await mkdir(path.join(w.workspaces[A], "03 Images"), { recursive: true });
    await symlink(path.join(w.outside, "secret.png"), path.join(w.workspaces[A], "03 Images", "escape.png"));
    for (const imagePath of ["../outside/secret.png", "03 Images/../../outside/secret.png", path.join(w.outside, "secret.png"), "03 Images\\escape.png", "03 Images/escape.png", "03 Images/none.png"]) {
      await refused(w.service.submit(submitInput({ imagePath }), producer), "image_review_file_unavailable");
    }
    assert.deepEqual(w.store.snapshot(A).images, {});
  });
});

test("BL-272 (DEVELOPMENT_PLAYBOOK §6.6): another channel's file is refused, and another channel's image is not found here", async () => {
  await withWorld(async (w) => {
    await w.put(B, SCENE_PATH, await png());
    await mkdir(path.join(w.workspaces[A], "03 Images"), { recursive: true });
    await symlink(path.join(w.workspaces[B], ...SCENE_PATH.split("/")), path.join(w.workspaces[A], "03 Images", "japan.png"));
    for (const imagePath of ["../02 Japan/" + SCENE_PATH, path.join(w.workspaces[B], ...SCENE_PATH.split("/")), "03 Images/japan.png"]) {
      await refused(w.service.submit(submitInput({ channelId: A, imagePath }), producer), "image_review_file_unavailable");
    }
    // The same relative path names the channel's OWN file: B's image is B's, and A cannot read or decide it.
    const { image } = await w.service.submit(submitInput({ channelId: B }), producer);
    await refused(w.service.get({ channelId: A, imageId: image.imageId }), "image_review_not_found");
    await refused(w.service.withdraw({ channelId: A, imageId: image.imageId }), "image_review_not_found");
    await refused(w.service.decide(A, image.imageId, { action: "approve" }, "u1"), "image_review_not_found");
    assert.equal(await w.service.imageFile(A, image.imageId).catch((e: unknown) => (isDomainError(e) ? e.code : e)), "image_review_not_found");
    // A channel not connected here is refused.
    await refused(w.service.list({ channelId: "UC_unknown" }), "CHANNEL_NOT_ACTIVE");
  });
});

test("BL-272: only a PNG or JPEG whose header matches its extension is accepted", async () => {
  await withWorld(async (w) => {
    await w.put(A, "a/fake.png", await jpeg());
    await w.put(A, "a/text.png", "not an image at all");
    await w.put(A, "a/x.gif", await png());
    await w.put(A, "a/x.webp", await png());
    for (const imagePath of ["a/fake.png", "a/text.png", "a/x.gif", "a/x.webp"]) await refused(w.service.submit(submitInput({ imagePath }), producer), "image_review_not_image");
    await w.put(A, "a/real.JPEG", await jpeg(1280, 720));
    const { image } = await w.service.submit(submitInput({ imagePath: "a/real.JPEG" }), producer);
    assert.deepEqual([image.width, image.height], [1280, 720]);
    // The same file twice while it waits is one request.
    await refused(w.service.submit(submitInput({ imagePath: "a/real.JPEG" }), producer), "image_review_duplicate");
  });
});

test("BL-272: requestId makes a submit idempotent -- a retry answers the stored image; the same id for another request is refused", async () => {
  await withWorld(async (w) => {
    await w.put(A, SCENE_PATH, await png());
    const first = await w.service.submit(submitInput({ requestId: "req-P46-1", batchId: "tropico-2026-11-23", note: "v1" }), producer);
    w.clock.t += 5_000;
    const retry = await w.service.submit(submitInput({ requestId: "req-P46-1", batchId: "tropico-2026-11-23", note: "v1" }), producer);
    assert.deepEqual([retry.replayed, retry.image.imageId, retry.image.submittedAt, retry.image.requestId], [true, first.image.imageId, "2026-11-23T10:00:00.000Z", "req-P46-1"]);
    assert.equal(Object.keys(w.store.snapshot(A).images).length, 1);
    // Still answered after the owner decided and the file changed (the retry carries no new file).
    await w.service.decide(A, first.image.imageId, { action: "approve" }, "u1");
    await w.put(A, SCENE_PATH, await png(1920, 1080, { r: 1, g: 2, b: 3 }));
    const later = await w.service.submit(submitInput({ requestId: "req-P46-1", batchId: "tropico-2026-11-23", note: "v1" }), producer);
    assert.deepEqual([later.replayed, later.image.imageId, later.image.status], [true, first.image.imageId, "approved"]);
    // The same requestId with another path, note, scene or batch is refused and stores nothing.
    for (const changed of [{ note: "v2" }, { sceneId: "P47" }, { batchId: "other" }, { imagePath: "03 Images/Scenes/P46/other.png" }]) {
      await refused(w.service.submit(submitInput({ requestId: "req-P46-1", batchId: "tropico-2026-11-23", note: "v1", ...changed }), producer), "image_review_request_conflict");
    }
    assert.equal(Object.keys(w.store.snapshot(A).images).length, 1);
    // requestIds are per channel: B may use the same one for its own request.
    await w.put(B, SCENE_PATH, await png());
    assert.equal((await w.service.submit(submitInput({ channelId: B, requestId: "req-P46-1" }), producer)).replayed, false);
  });
});

test("BL-272: a batch is the submits sharing a batchId -- listed together, filtered by batchId, at most 40 images", async () => {
  await withWorld(async (w) => {
    for (const scene of ["P46", "P47", "P48"]) {
      await w.put(A, `03 Images/Scenes/${scene}/master.png`, await png());
      await w.service.submit(submitInput({ sceneId: scene, imagePath: `03 Images/Scenes/${scene}/master.png`, batchId: "b-1" }), producer);
      w.clock.t += 1_000;
    }
    await w.put(A, "03 Images/single.png", await png());
    await w.service.submit(submitInput({ sceneId: "P50", imagePath: "03 Images/single.png" }), producer);
    const batch = await w.service.list({ channelId: A, batchId: "b-1" });
    assert.deepEqual([batch.images.map((i) => i.sceneId), batch.pending], [["P46", "P47", "P48"], 3]);
    assert.deepEqual((await w.service.list({ channelId: A })).images.map((i) => i.batchId), ["b-1", "b-1", "b-1", null]);
    // The 41st image of one batch is refused (a new batchId starts a new grid).
    for (let i = 4; i <= 40; i++) {
      await w.put(A, `fill/${i}.png`, await png(32, 32));
      await w.service.submit(submitInput({ sceneId: `F${i}`, imagePath: `fill/${i}.png`, batchId: "b-1" }), producer);
    }
    await w.put(A, "fill/41.png", await png(32, 32));
    await refused(w.service.submit(submitInput({ sceneId: "F41", imagePath: "fill/41.png", batchId: "b-1" }), producer), "image_review_batch_full");
    assert.equal((await w.service.submit(submitInput({ sceneId: "F41", imagePath: "fill/41.png", batchId: "b-2" }), producer)).image.batchId, "b-2");
  });
});

test("BL-272: the owner's three answers -- approve, approve with a note, return with a comment -- each recorded with his words, audited and nudging the Inbox writer", async () => {
  await withWorld(async (w) => {
    const ids: string[] = [];
    for (const scene of ["P46", "P47", "P48"]) {
      await w.put(A, `03 Images/Scenes/${scene}/master.png`, await png());
      ids.push((await w.service.submit(submitInput({ sceneId: scene, imagePath: `03 Images/Scenes/${scene}/master.png`, batchId: "b-1" }), producer)).image.imageId);
    }
    w.clock.t += 60_000;
    // Refused at input: a note-approval or a return without words, a plain approval with words, an unknown action.
    await refused(w.service.decide(A, ids[0], { action: "approve_with_note" }, "u1"), "validation_failed");
    await refused(w.service.decide(A, ids[0], { action: "return", comment: "   " }, "u1"), "validation_failed");
    await refused(w.service.decide(A, ids[0], { action: "approve", comment: "nice" }, "u1"), "validation_failed");
    await refused(w.service.decide(A, ids[0], { action: "reject", comment: "x" }, "u1"), "validation_failed");
    assert.deepEqual(w.store.snapshot(A).decisions, {});

    const approved = (await w.service.decide(A, ids[0], { action: "approve" }, "u1")).image;
    const noted = (await w.service.decide(A, ids[1], { action: "approve_with_note", comment: "  убрать прохожего  " }, "u1")).image;
    const returned = (await w.service.decide(A, ids[2], { action: "return", comment: "небо слишком светлое" }, "u1")).image;
    assert.deepEqual(
      [approved, noted, returned].map((v) => [v.status, v.comment, v.decidedAt, v.decidedOn, v.file]),
      [
        ["approved", null, "2026-11-23T10:01:00.000Z", "Mac", "ok"],
        ["approved_with_note", "убрать прохожего", "2026-11-23T10:01:00.000Z", "Mac", "ok"],
        ["returned", "небо слишком светлое", "2026-11-23T10:01:00.000Z", "Mac", "ok"],
      ]
    );
    assert.deepEqual(w.audits.map((a) => [a.imageId, a.detail.event, a.detail.comment, a.detail.by]), [
      [ids[0], "image_review.approved", null, "u1"],
      [ids[1], "image_review.approved_with_note", "убрать прохожего", "u1"],
      [ids[2], "image_review.returned", "небо слишком светлое", "u1"],
    ]);
    assert.equal(w.nudges.length, 3);
    // A decided image is never decided again here, nor withdrawn.
    await refused(w.service.decide(A, ids[0], { action: "return", comment: "передумал" }, "u1"), "image_review_not_pending");
    await refused(w.service.withdraw({ channelId: A, imageId: ids[1] }), "image_review_not_pending");
    assert.deepEqual(await w.service.list({ channelId: A, batchId: "b-1", status: "approved_with_note" }).then((r) => r.images.map((i) => i.imageId)), [ids[1]]);
  });
});

test("BL-272 (ADR 0061 §5): two computers' answers merge by rule -- the earliest owner decision counts; a withdrawal only without one", async () => {
  const { imageViewOf } = await import("./model");
  const image = { imageId: "img_1", channelId: A, sceneId: "P46", imagePath: SCENE_PATH, note: "", batchId: null, requestId: null, width: 1920, height: 1080, sizeBytes: 1, sha256: "s", submittedAt: "2026-11-23T09:00:00.000Z", submittedBy: "t", device: "Mac" };
  const decisions = [
    { id: "d_b", imageId: "img_1", kind: "returned" as const, by: "owner" as const, comment: "темно", device: "Windows", at: "2026-11-23T10:00:05.000Z" },
    { id: "d_a", imageId: "img_1", kind: "approved_with_note" as const, by: "owner" as const, comment: "убрать прохожего", device: "Mac", at: "2026-11-23T10:00:00.000Z" },
    { id: "w_1", imageId: "img_1", kind: "withdrawn" as const, by: "producer" as const, comment: null, device: "Mac", at: "2026-11-23T09:30:00.000Z" },
  ];
  assert.deepEqual([imageViewOf(image, decisions).status, imageViewOf(image, decisions).comment, imageViewOf(image, decisions).decidedOn], ["approved_with_note", "убрать прохожего", "Mac"]);
  assert.equal(imageViewOf(image, [...decisions].reverse()).status, "approved_with_note");
  assert.equal(imageViewOf(image, [decisions[2]]).status, "withdrawn");
  assert.equal(imageViewOf(image, []).status, "pending");
});
