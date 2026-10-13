import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type StoryboardComment, type StoryboardsDocument, type StoryboardVersion } from "./contracts";
import { createStoryboardsCore, emptyDocument } from "./services";

// BL-184 (FO-REQ-0024 §5 step 7: "storyboards, comments and approvals show the same on both computers"; ADR 0038 §2): the Operator
// writes versions on one computer, the owner comments and decides on either; after one sync cycle both computers hold the same
// storyboard, and two computers adding comments at the same time keep both.

const CH = "UC_tropico";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createStoryboardsCore({ core: createAutomergeCore<StoryboardsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
}
type Computer = ReturnType<typeof computer>;

async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

const version = (title: string): StoryboardVersion => ({
  number: 1,
  createdAt: "2026-10-13T12:00:00Z",
  title,
  loop: true,
  keyframes: [
    { id: "K0", file: "Sent to YTM/H-0004/bar/K0.jpg", sha256: "a", bytes: 10, caption: null, parentKeyframeId: null },
    { id: "K1", file: "Sent to YTM/H-0004/bar/K1.jpg", sha256: "b", bytes: 10, caption: null, parentKeyframeId: "K0" },
  ],
  segments: [{ id: "S1", fromKeyframeId: "K0", toKeyframeId: "K1", action: "puts the glass away", durationSeconds: 8, model: "ltx", settings: { frames: 193 }, estimateUsd: null }],
  props: [{ id: "glass", name: "Glass", kind: "object", cells: { K0: "in his hand", K1: "under the counter" } }],
  notes: null,
});
const comment = (id: string, text: string): StoryboardComment => ({
  id,
  versionNumber: 1,
  target: { kind: "keyframe", keyframeId: "K1", region: { x: 0.4, y: 0.5, r: 0.05 } },
  author: "owner",
  device: null,
  text,
  createdAt: "2026-10-13T12:05:00Z",
  state: "open",
  stateChangedAt: null,
  stateChangedBy: null,
  replies: {},
});

test("a storyboard made on the Mac is on Windows after one cycle; a computer without the document has an empty list", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await windows.read(CH), []);
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  await mac.submit(CH, "sb1", 1, "2026-10-13T12:01:00Z");
  await cycle(mac, windows);
  const [onWindows] = await windows.read(CH);
  assert.equal(onWindows.versions["1"].title, "Bar loop");
  assert.deepEqual(onWindows.versions["1"].props[0].cells, { K0: "in his hand", K1: "under the counter" });
  assert.equal(onWindows.submissions["1"].at, "2026-10-13T12:01:00Z");
});

test("comments and decisions from both computers at once are all kept; a new version gets the next number", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  await cycle(mac, windows);
  await windows.addComment(CH, "sb1", comment("c-win", "where is the glass?"));
  await mac.addComment(CH, "sb1", comment("c-mac", "towel position"));
  await windows.addDecision(CH, "sb1", { id: "d1", kind: "changes_requested", versionNumber: 1, by: "owner", device: "Windows", at: "2026-10-13T12:06:00Z", note: null });
  assert.equal(await mac.addVersion(CH, "sb1", { ...version("Bar loop"), createdAt: "2026-10-13T12:10:00Z" }), 2);
  await mac.addReply(CH, "sb1", "c-mac", { id: "r1", author: "operator", device: null, text: "fixed in v2", createdAt: "2026-10-13T12:11:00Z" });
  await cycle(mac, windows);
  for (const c of [mac, windows]) {
    const [sb] = await c.read(CH);
    assert.deepEqual(Object.keys(sb.comments).sort(), ["c-mac", "c-win"]);
    assert.deepEqual(Object.keys(sb.versions).sort(), ["1", "2"]);
    assert.equal(sb.decisions.d1.kind, "changes_requested");
    assert.equal(sb.comments["c-mac"].replies.r1.text, "fixed in v2");
  }
  await windows.setCommentState(CH, "sb1", "c-win", "resolved", "operator", "2026-10-13T12:12:00Z");
  await cycle(mac, windows);
  assert.equal((await mac.read(CH))[0].comments["c-win"].state, "resolved");
});

test("refusals: an existing id, a missing storyboard, version or comment change nothing", async () => {
  const mac = computer();
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  const code = async (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: unknown) => isDomainError(e) && e.code === expected);
  await code(mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("again")), "validation_failed");
  await code(mac.submit(CH, "nope", 1, "2026-10-13T12:00:00Z"), "not_found");
  await code(mac.submit(CH, "sb1", 7, "2026-10-13T12:00:00Z"), "not_found");
  await code(mac.addReply(CH, "sb1", "missing", { id: "r", author: "owner", device: null, text: "x", createdAt: "2026-10-13T12:00:00Z" }), "not_found");
  const [sb] = await mac.read(CH);
  assert.deepEqual([Object.keys(sb.versions), Object.keys(sb.submissions)], [["1"], []]);
});
