import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type ImageReviewDecision, type ImageReviewImage, type ImageReviewsDocument } from "./contracts";
import { createImageReviewsCore, emptyDocument } from "./services";

// BL-272 (ADR 0076, as ADR 0061 §1): the Producer submits on one computer, the owner decides on the other; after one sync cycle both
// computers hold the same images and decisions, and images or decisions added on both at once are all kept.

const CH = "UC_img_sync";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createImageReviewsCore({ core: createAutomergeCore<ImageReviewsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
}
type Computer = ReturnType<typeof computer>;

async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

const image = (imageId: string): ImageReviewImage => ({
  imageId,
  channelId: CH,
  sceneId: "P46",
  imagePath: `03 Images/Scenes/P46/${imageId}.png`,
  note: "",
  batchId: "b-1",
  requestId: `req-${imageId}`,
  width: 1920,
  height: 1080,
  sizeBytes: 4_000_000,
  sha256: "a".repeat(64),
  submittedAt: "2026-11-23T10:00:00.000Z",
  submittedBy: "tok",
  device: "Mac",
});
const decision = (id: string, imageId: string, kind: ImageReviewDecision["kind"], comment: string | null): ImageReviewDecision => ({ id, imageId, kind, by: kind === "withdrawn" ? "producer" : "owner", comment, device: "Windows", at: "2026-11-23T11:00:00.000Z" });

test("BL-272: an image submitted on the Mac is on Windows after one cycle; the owner's note-approval on Windows reaches the Mac", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await windows.read(CH), { images: {}, decisions: {} });
  await mac.addImage(CH, image("i1"));
  await cycle(mac, windows);
  assert.deepEqual((await windows.read(CH)).images.i1, image("i1"));
  await windows.addDecision(CH, decision("d1", "i1", "approved_with_note", "убрать прохожего"));
  await cycle(mac, windows);
  assert.deepEqual((await mac.read(CH)).decisions.d1, decision("d1", "i1", "approved_with_note", "убрать прохожего"));
});

test("BL-272: images and decisions added on both computers at once are all kept after a cycle", async () => {
  const mac = computer();
  const windows = computer();
  await mac.addImage(CH, image("i1"));
  await windows.addImage(CH, image("i2"));
  await mac.addDecision(CH, decision("d1", "i1", "returned", "темно"));
  await windows.addDecision(CH, decision("d2", "i2", "approved", null));
  await cycle(mac, windows);
  for (const side of [mac, windows]) {
    const snapshot = await side.read(CH);
    assert.deepEqual(Object.keys(snapshot.images).sort(), ["i1", "i2"]);
    assert.deepEqual(Object.keys(snapshot.decisions).sort(), ["d1", "d2"]);
  }
});
