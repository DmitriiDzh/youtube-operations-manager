import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
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
  const core = createStoryboardsCore({ core: createAutomergeCore<StoryboardsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  /** A storyboard as a build before BL-189 made it: without the `renders` / `renderDecisions` maps. */
  const makeLegacy = async (storyboardId: string) => {
    const doc = Automerge.load<StoryboardsDocument>(bytes.get(CH)!);
    const next = Automerge.change(doc, (draft) => {
      delete draft.storyboards[storyboardId].renders;
      delete draft.storyboards[storyboardId].renderDecisions;
    });
    bytes.set(CH, Automerge.save(next));
  };
  return Object.assign(core, { makeLegacy });
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
  contentHash: "h1",
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
  await windows.addDecision(CH, "sb1", { id: "d1", kind: "changes_requested", versionNumber: 1, contentHash: "h1", by: "owner", device: "Windows", at: "2026-10-13T12:06:00Z", note: null });
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

test("BL-184 stage 2: the channel's gate setting -- absent until changed, then the same on both computers after a cycle", async () => {
  const mac = computer();
  const windows = computer();
  assert.equal(await mac.readGate(CH), null);
  await windows.setGate(CH, { requireApproved: false, changedAt: "2026-10-13T13:00:00Z", changedBy: "Windows" });
  await cycle(mac, windows);
  assert.deepEqual(await mac.readGate(CH), { requireApproved: false, changedAt: "2026-10-13T13:00:00Z", changedBy: "Windows" });
  await mac.setGate(CH, { requireApproved: true, changedAt: "2026-10-13T13:05:00Z", changedBy: "Mac" });
  await cycle(mac, windows);
  assert.equal((await windows.readGate(CH))?.requireApproved, true);
});

test("BL-184 stage 3: a take picked for a segment on one computer is on the other after a cycle; clearing it too", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  await cycle(mac, windows);
  await windows.setPick(CH, "sb1", 1, "S1", { source: "gemini", jobId: "gm_1", device: "Windows", at: "2026-10-13T14:00:00Z" });
  await cycle(mac, windows);
  assert.deepEqual((await mac.read(CH))[0].picks, { "1": { S1: { source: "gemini", jobId: "gm_1", device: "Windows", at: "2026-10-13T14:00:00Z" } } });
  await mac.setPick(CH, "sb1", 1, "S1", null);
  await cycle(mac, windows);
  assert.deepEqual((await windows.read(CH))[0].picks, { "1": {} });
  await assert.rejects(mac.setPick(CH, "sb1", 9, "S1", null), (e: unknown) => isDomainError(e) && e.code === "not_found");
});

// Independent review (BL-184): both computers' first picks merge -- the picks map exists from the start.
test("picks made on both computers before a sync are both kept", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  await cycle(mac, windows);
  await mac.setPick(CH, "sb1", 1, "S1", { source: "gemini", jobId: "gm_1", device: "Mac", at: "2026-10-13T14:00:00Z" });
  await windows.setPick(CH, "sb1", 1, "S2", { source: "media", jobId: "job-2", device: "Windows", at: "2026-10-13T14:00:01Z" });
  await cycle(mac, windows);
  for (const c of [mac, windows]) assert.deepEqual(Object.keys((await c.read(CH))[0].picks?.["1"] ?? {}).sort(), ["S1", "S2"]);
});

// Independent review (BL-184): two computers that both write "version 2" before a sync keep one body; the owner's approval of the
// other body must not approve it. Decisions and submissions name the content hash they were made on.
test("an approval of one computer's version 2 never approves the other computer's version 2", async () => {
  const { storyboardState } = await import("@/lib/storyboards/model");
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "sb1", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar loop"));
  await cycle(mac, windows);
  await mac.addVersion(CH, "sb1", { ...version("A content"), contentHash: "hash-A" });
  await mac.submit(CH, "sb1", 2, "2026-10-13T12:10:00Z");
  await mac.addDecision(CH, "sb1", { id: "d1", kind: "approved", versionNumber: 2, contentHash: "hash-A", by: "owner", device: "Mac", at: "2026-10-13T12:11:00Z", note: null });
  await windows.addVersion(CH, "sb1", { ...version("B content"), contentHash: "hash-B" });
  await cycle(mac, windows);
  for (const c of [mac, windows]) {
    const [sb] = await c.read(CH);
    const survivor = sb.versions["2"].contentHash;
    assert.equal(storyboardState(sb) === "approved", survivor === "hash-A", `the surviving body ${survivor} is approved only if it is the approved one`);
  }
});

test("BL-189 (FO-REQ-0025 §3 step 3): a final file attached on the Mac and the owner's verdicts from both computers are all on both after a cycle", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "bar_loop", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar"));
  await cycle(mac, windows);
  const render = { id: "rn_1", versionNumber: 1, contentHash: "h1", file: "Sent to YTM/H-0004/bar/v3/loop_s8.mp4", sha256: "f", bytes: 9, picks: { S1: { source: "media" as const, jobId: "j1" } }, notes: "s8", createdAt: "2026-10-14T16:00:00Z", device: "Mac" };
  await mac.addRender(CH, "bar_loop", render);
  await cycle(mac, windows);
  // The owner decides on both computers before the next sync: both verdicts are kept (one map, made with the render).
  await windows.addRenderDecision(CH, "bar_loop", { id: "rd_w", renderId: "rn_1", kind: "changes_requested", by: "owner", device: "Windows", at: "2026-10-14T16:05:00Z", note: "S3 joint" });
  await mac.addRenderDecision(CH, "bar_loop", { id: "rd_m", renderId: "rn_1", kind: "approved", by: "owner", device: "Mac", at: "2026-10-14T16:06:00Z", note: null });
  await cycle(mac, windows);
  for (const side of [mac, windows]) {
    const [record] = await side.read(CH);
    assert.deepEqual(record.renders, { rn_1: render });
    assert.deepEqual(Object.keys(record.renderDecisions ?? {}).sort(), ["rd_m", "rd_w"]);
  }
  await assert.rejects(windows.addRenderDecision(CH, "bar_loop", { id: "rd_x", renderId: "rn_nope", kind: "approved", by: "owner", device: null, at: "2026-10-14T16:07:00Z", note: null }), (e: unknown) => isDomainError(e) && e.code === "not_found");
  await assert.rejects(mac.addRender(CH, "bar_loop", { ...render, id: "rn_2", versionNumber: 9 }), (e: unknown) => isDomainError(e) && e.code === "not_found");
});

// Independent review (BL-189): the Operator may attach on either computer; two first renders attached before a sync are both kept
// (STORYBOARD_TAKES_PLAN.md §2.4: every attach adds a render, none is lost or edited) -- the maps must not be made by each computer.
test("BL-189: first final files attached on both computers before a sync are both kept, with a verdict on each", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "bar_loop", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar"));
  await cycle(mac, windows);
  const base = { versionNumber: 1, contentHash: "h1", sha256: "f", bytes: 9, picks: {}, notes: null, createdAt: "2026-10-14T16:00:00Z" };
  await mac.addRender(CH, "bar_loop", { ...base, id: "rn_mac", file: "Sent to YTM/a.mp4", device: "Mac" });
  await windows.addRender(CH, "bar_loop", { ...base, id: "rn_win", file: "Sent to YTM/b.mp4", device: "Windows" });
  await mac.addRenderDecision(CH, "bar_loop", { id: "rd_mac", renderId: "rn_mac", kind: "approved", by: "owner", device: "Mac", at: "2026-10-14T16:05:00Z", note: null });
  await windows.addRenderDecision(CH, "bar_loop", { id: "rd_win", renderId: "rn_win", kind: "changes_requested", by: "owner", device: "Windows", at: "2026-10-14T16:05:00Z", note: "x" });
  await cycle(mac, windows);
  for (const side of [mac, windows]) {
    const [record] = await side.read(CH);
    assert.deepEqual(Object.keys(record.renders ?? {}).sort(), ["rn_mac", "rn_win"]);
    assert.deepEqual(Object.keys(record.renderDecisions ?? {}).sort(), ["rd_mac", "rd_win"]);
  }
});

// Independent review (BL-189): a storyboard made before BL-189 (bar_loop v3) gets its maps with its first render. Two computers that
// each attach a first render (and give a verdict) before a sync made two maps: every render and verdict is still read.
test("BL-189: a storyboard made before BL-189 keeps first final files attached on both computers before a sync, and their verdicts", async () => {
  const mac = computer();
  const windows = computer();
  await mac.create(CH, { id: "bar_loop", createdAt: "2026-10-13T12:00:00Z", createdBy: "operator", planId: null }, version("Bar"));
  await mac.makeLegacy("bar_loop");
  await cycle(mac, windows);
  assert.equal((await windows.read(CH))[0].renders, undefined);
  const base = { versionNumber: 1, contentHash: "h1", sha256: "f", bytes: 9, picks: {}, notes: null, createdAt: "2026-10-14T16:00:00Z" };
  await mac.addRender(CH, "bar_loop", { ...base, id: "rn_mac", file: "Sent to YTM/a.mp4", device: "Mac" });
  await windows.addRender(CH, "bar_loop", { ...base, id: "rn_win", file: "Sent to YTM/b.mp4", device: "Windows" });
  await mac.addRenderDecision(CH, "bar_loop", { id: "rd_mac", renderId: "rn_mac", kind: "approved", by: "owner", device: "Mac", at: "2026-10-14T16:05:00Z", note: null });
  await cycle(mac, windows);
  // After the sync, a verdict on either render is accepted on either computer.
  await windows.addRenderDecision(CH, "bar_loop", { id: "rd_w1", renderId: "rn_mac", kind: "changes_requested", by: "owner", device: "Windows", at: "2026-10-14T16:06:00Z", note: "x" });
  await mac.addRenderDecision(CH, "bar_loop", { id: "rd_m2", renderId: "rn_win", kind: "approved", by: "owner", device: "Mac", at: "2026-10-14T16:07:00Z", note: null });
  await cycle(mac, windows);
  for (const side of [mac, windows]) {
    const [record] = await side.read(CH);
    assert.deepEqual(Object.keys(record.renders ?? {}).sort(), ["rn_mac", "rn_win"]);
    assert.deepEqual(Object.keys(record.renderDecisions ?? {}).sort(), ["rd_m2", "rd_mac", "rd_w1"]);
  }
});
