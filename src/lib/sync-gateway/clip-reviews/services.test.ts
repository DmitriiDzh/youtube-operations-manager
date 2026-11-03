import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type ClipReviewClip, type ClipReviewDecision, type ClipReviewsDocument } from "./contracts";
import { createClipReviewsCore, emptyDocument } from "./services";

// BL-241 AC-CR-10 (CLIP_REVIEWS_PLAN.md item 7, ADR 0061 §1): the Producer submits on one computer, the owner decides on the other;
// after one sync cycle both computers hold the same clips and decisions, and clips or decisions added on both at once are all kept.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createClipReviewsCore({ core: createAutomergeCore<ClipReviewsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
}
type Computer = ReturnType<typeof computer>;

async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

const clip = (clipId: string): ClipReviewClip => ({
  clipId,
  channelId: CH,
  sceneId: "bar-night",
  clipPath: "03 Images/Scenes/bar-night/preview_30s.mp4",
  note: "slower rain",
  startSec: null,
  endSec: null,
  durationSeconds: 30,
  sizeBytes: 104_857_600,
  sha256: "a".repeat(64),
  submittedAt: "2026-11-03T10:00:00.000Z",
  submittedBy: "tok",
  device: "Mac",
});
const decision = (id: string, clipId: string, kind: ClipReviewDecision["kind"]): ClipReviewDecision => ({
  id,
  clipId,
  kind,
  by: kind === "withdrawn" ? "producer" : "owner",
  comment: kind === "returned" ? "too dark" : null,
  device: "Windows",
  at: "2026-11-03T11:00:00.000Z",
});

test("AC-CR-10: a clip submitted on the Mac is on Windows after one cycle; the owner's return on Windows reaches the Mac", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await windows.read(CH), { clips: {}, decisions: {} });
  await mac.addClip(CH, clip("c1"));
  await cycle(mac, windows);
  assert.deepEqual((await windows.read(CH)).clips.c1, clip("c1"));
  await windows.addDecision(CH, decision("d1", "c1", "returned"));
  await cycle(mac, windows);
  assert.deepEqual((await mac.read(CH)).decisions.d1, decision("d1", "c1", "returned"));
});

test("AC-CR-10: clips and decisions added on both computers at once are all kept on both", async () => {
  const mac = computer();
  const windows = computer();
  await mac.addClip(CH, clip("c1"));
  await windows.addClip(CH, clip("c2"));
  await cycle(mac, windows);
  await mac.addDecision(CH, decision("d-mac", "c1", "approved"));
  await windows.addDecision(CH, decision("d-win", "c1", "returned"));
  await cycle(mac, windows);
  for (const c of [mac, windows]) {
    const read = await c.read(CH);
    assert.deepEqual(Object.keys(read.clips).sort(), ["c1", "c2"]);
    assert.deepEqual(Object.keys(read.decisions).sort(), ["d-mac", "d-win"]);
  }
});
