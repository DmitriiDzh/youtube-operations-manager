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
  const sb = { latestVersion: 2, submissions: [{ versionNumber: 1, at: "x" }, { versionNumber: 2, at: "y" }] };
  assert.equal(decisionsOffered(sb, 2), true);
  assert.equal(decisionsOffered(sb, 1), false);
  assert.equal(decisionsOffered({ latestVersion: 3, submissions: sb.submissions }, 3), false);
});

test("B3 marks: replaced and added keyframes, edited and added segments, and changed cells are marked", () => {
  const marks = changedMarks({ keyframesReplaced: ["K1"], keyframesAdded: ["K4"], keyframesRemoved: ["K9"], segmentsChanged: ["S3"], segmentsAdded: ["S5"], segmentsRemoved: [], propCellsChanged: [{ propId: "glass", keyframeId: "K2" }], notesChanged: false });
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
