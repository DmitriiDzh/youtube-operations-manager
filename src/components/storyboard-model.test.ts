import assert from "node:assert/strict";
import test from "node:test";
import type { StoryboardVersion } from "@/lib/sync-gateway";
import { changedMarks, commentsFor, decisionsOffered, filmstripOf, keyframeSrc, openCounts, pinsOn, sortForOwner, targetKey, type DetailComment } from "./storyboard-model";

// BL-184 stage 1 (FO-REQ-0024 §4 B2): the screen's rules, with expectations written from the request -- "K0 → [S1] → K1 → … → back
// to K0 if looped", comments on a keyframe (with pins), a segment, a prop cell or the whole storyboard, decisions on the latest
// submitted version only.

const kf = (id: string) => ({ id, file: `Sent to YTM/bar/${id}.jpg`, sha256: id, bytes: 1, caption: null, parentKeyframeId: null });
const seg = (id: string, from: string, to: string) => ({ id, fromKeyframeId: from, toKeyframeId: to, action: id, durationSeconds: 8, model: null, settings: {}, estimateUsd: null });
const version = (loop: boolean): StoryboardVersion => ({
  number: 1,
  createdAt: "2026-10-13T12:00:00Z",
  title: "Bar loop",
  loop,
  keyframes: ["K0", "K1", "K2", "K3"].map(kf),
  // Stored in chain order by the module; listed out of order here to show the strip follows the keyframes, not the array.
  segments: loop ? [seg("S4", "K3", "K0"), seg("S1", "K0", "K1"), seg("S3", "K2", "K3"), seg("S2", "K1", "K2")] : [seg("S1", "K0", "K1"), seg("S2", "K1", "K2"), seg("S3", "K2", "K3")],
  props: [],
  notes: null,
  contentHash: "h1",
});
const label = (item: ReturnType<typeof filmstripOf>[number]) => (item.kind === "segment" ? item.segment.id : item.closing ? `↺${item.keyframe.id}` : item.keyframe.id);

test("B2 filmstrip: K0 → S1 → K1 → … → K3, and with loop → S4 → back to K0", () => {
  assert.deepEqual(filmstripOf(version(true)).map(label), ["K0", "S1", "K1", "S2", "K2", "S3", "K3", "S4", "↺K0"]);
  assert.deepEqual(filmstripOf(version(false)).map(label), ["K0", "S1", "K1", "S2", "K2", "S3", "K3"]);
});

const comment = (id: string, target: DetailComment["target"], extra: Partial<DetailComment> = {}): DetailComment => ({
  id,
  versionNumber: 2,
  target,
  author: "owner",
  device: null,
  text: id,
  createdAt: "2026-10-13T12:00:00Z",
  state: "open",
  stateChangedAt: null,
  stateChangedBy: null,
  replies: [],
  ...extra,
});

test("B2 comments: one target key per keyframe, segment, prop cell or the whole storyboard; counts are the open ones of the version shown", () => {
  assert.deepEqual(
    [{ kind: "storyboard" as const }, { kind: "keyframe" as const, keyframeId: "K2", region: null }, { kind: "segment" as const, segmentId: "S2" }, { kind: "prop" as const, propId: "glass", keyframeId: "K2" }].map(targetKey),
    ["storyboard", "keyframe:K2", "segment:S2", "prop:glass:K2"]
  );
  const comments = [
    comment("a", { kind: "keyframe", keyframeId: "K2", region: { x: 0.4, y: 0.5, r: 0.05 } }),
    comment("b", { kind: "keyframe", keyframeId: "K2", region: null }),
    comment("c", { kind: "keyframe", keyframeId: "K2", region: { x: 0.1, y: 0.1, r: 0.05 } }, { state: "resolved" }),
    comment("d", { kind: "keyframe", keyframeId: "K2", region: { x: 0.2, y: 0.2, r: 0.05 } }, { versionNumber: 1 }),
    comment("e", { kind: "segment", segmentId: "S2" }),
  ];
  assert.deepEqual([...openCounts(comments, 2)], [["keyframe:K2", 2], ["segment:S2", 1]]);
  // A v1 remark on K2 still shows on v2's K2 thread; open ones first.
  assert.deepEqual(commentsFor(comments, "keyframe:K2").map((c) => c.id), ["a", "b", "d", "c"]);
  assert.equal(commentsFor(comments, null).length, 5);
  // Pins: only the version shown's (a region belongs to that version's image), numbered in order; a resolved one keeps its number.
  assert.deepEqual(pinsOn(comments, "K2", 2).map((p) => [p.commentId, p.number, p.state]), [["a", 1, "open"], ["c", 2, "resolved"]]);
  assert.deepEqual(pinsOn(comments, "K2", 1).map((p) => p.commentId), ["d"]);
});

test("B2/B3 decisions: offered on the latest version once submitted -- never on a draft or an older version", () => {
  const sb = { latestVersion: 2, submittedAt: "2026-10-13T12:00:00Z" };
  assert.equal(decisionsOffered(sb, 2), true);
  assert.equal(decisionsOffered(sb, 1), false);
  assert.equal(decisionsOffered({ latestVersion: 3, submittedAt: null }, 3), false);
});

test("B3 marks: replaced and added keyframes, edited and added segments, and changed cells are marked", () => {
  const marks = changedMarks({ keyframesReplaced: ["K1"], keyframesAdded: ["K4"], keyframesRemoved: ["K9"], segmentsChanged: ["S3"], segmentsAdded: ["S5"], segmentsRemoved: [], propCellsChanged: [{ propId: "glass", keyframeId: "K2" }], notesChanged: false, keyframesEdited: [], orderChanged: false, titleChanged: false, loopChanged: false });
  assert.deepEqual([[...marks.keyframes], [...marks.segments], [...marks.cells]], [["K1", "K4"], ["S3", "S5"], ["glass|K2"]]);
  assert.deepEqual([...changedMarks(null).keyframes], []);
});

test("the list puts what waits for the owner first, then changes requested, drafts, approved; newest first within", () => {
  const row = (id: string, state: "draft" | "in_review" | "changes_requested" | "approved", updatedAt: string) => ({ storyboardId: id, state, updatedAt }) as Parameters<typeof sortForOwner>[0][number];
  const sorted = sortForOwner([row("a", "approved", "2026-10-13T15:00:00Z"), row("b", "in_review", "2026-10-12T10:00:00Z"), row("c", "draft", "2026-10-13T16:00:00Z"), row("d", "in_review", "2026-10-13T09:00:00Z"), row("e", "changes_requested", "2026-10-13T08:00:00Z")]);
  assert.deepEqual(sorted.map((s) => s.storyboardId), ["d", "b", "e", "c", "a"]);
});

test("a keyframe's image address escapes its parts", () => {
  assert.equal(keyframeSrc("UC_x", "bar loop", 2, "K/0"), "/api/channels/UC_x/storyboards/bar%20loop/keyframes/2/K%2F0");
});

// BL-184 stage 3 -- FO-REQ-0024 B5 / §5 step 5: "S1–S4 takes appear between their keyframes; the owner picks one take per segment,
// checks the four joints with the seam tools, and plays the assembled 30 s loop".
const take = (jobId: string, segmentId: string, over: Partial<import("./storyboard-model").TakeView> = {}) => ({
  source: "gemini" as const,
  jobId,
  segmentId,
  versionNumber: 2,
  status: "done",
  createdAt: `2026-10-13T12:0${jobId.length}:00Z`,
  label: "omni",
  error: null,
  hasVideo: true,
  ...over,
});

test("B5: takes grouped per segment of the version shown; a take's state for its card", async () => {
  const { takesBySegment, takeState } = await import("./storyboard-model");
  const takes = [take("a", "S1"), take("b", "S1"), take("c", "S2"), take("old", "S1", { versionNumber: 1 })];
  assert.deepEqual([...takesBySegment(takes, 2)].map(([s, list]) => [s, list.map((t) => t.jobId)]), [["S1", ["a", "b"]], ["S2", ["c"]]]);
  assert.deepEqual(
    [take("x", "S1"), take("x", "S1", { status: "generating", hasVideo: false }), take("x", "S1", { status: "failed", hasVideo: false }), take("x", "S1", { status: "done", hasVideo: false })].map(takeState),
    ["ready", "working", "failed", "failed"]
  );
});

test("§5 step 5: the four joints of the looped bar chain, each with the picked takes on both sides; the assembled loop once all four are picked", async () => {
  const { jointsOf, assembledLoop } = await import("./storyboard-model");
  const v = { ...version(true), number: 2 };
  const takes = [take("s1", "S1"), take("s2", "S2"), take("s3", "S3"), take("s4", "S4"), take("s4b", "S4", { status: "generating", hasVideo: false })];
  const picks = { S1: { source: "gemini" as const, jobId: "s1" }, S2: { source: "gemini" as const, jobId: "s2" }, S3: { source: "gemini" as const, jobId: "s3" } };
  const joints = jointsOf(v, takes, picks);
  assert.deepEqual(joints.map((j) => [j.from.id, j.to.id, j.fromTake?.jobId ?? null, j.toTake?.jobId ?? null, j.closing]), [
    ["S1", "S2", "s1", "s2", false],
    ["S2", "S3", "s2", "s3", false],
    ["S3", "S4", "s3", null, false],
    ["S4", "S1", null, "s1", true],
  ]);
  assert.deepEqual(assembledLoop(v, takes, picks), { takes: [], missing: ["S4"] });
  // A pick of a take still being made does not count; once S4's playable take is picked, the loop plays S1..S4 in order.
  assert.deepEqual(assembledLoop(v, takes, { ...picks, S4: { source: "gemini", jobId: "s4b" } }).missing, ["S4"]);
  assert.deepEqual(assembledLoop(v, takes, { ...picks, S4: { source: "gemini", jobId: "s4" } }).takes.map((t) => t.jobId), ["s1", "s2", "s3", "s4"]);
  // Without loop there is no closing joint.
  assert.deepEqual(jointsOf({ ...version(false), number: 2 }, takes, picks).map((j) => `${j.from.id}>${j.to.id}`), ["S1>S2", "S2>S3"]);
});
