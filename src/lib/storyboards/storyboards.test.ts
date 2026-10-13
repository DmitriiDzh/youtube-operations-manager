import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CH, V1, V1_GLASS, V2_GLASS, barLoop, code, segments, setup, sha } from "@/test-support/storyboards-harness";
import { approvedVersion, changedPropCells } from "./model";

// BL-184 stage 1 -- acceptance FO-REQ-0024 §5 steps 1-3 (B1 content, B2 review, B3 versions), on the REAL workspace-exchange rules
// over a temporary channel folder (`src/test-support/storyboards-harness.ts`). Expected values come from the request and from the
// harness's own bytes: every sha256 below is computed with node:crypto over the bytes it wrote, never read back from the module.

test("§5 step 1 (B1): the Operator creates 'Bar loop' v1 from the four bar keyframes; each file's sha256 is frozen; a draft until submitted", async () => {
  const { service, cleanup } = await setup();
  try {
    // The segments arrive out of order; the storyboard keeps them in the chain's order K0 -> K1 -> K2 -> K3 -> K0.
    const input = barLoop();
    const { storyboard } = await service.create({ ...input, segments: [input.segments[2], input.segments[0], input.segments[3], input.segments[1]] });
    assert.equal(storyboard.state, "draft");
    assert.equal(storyboard.latestVersion, 1);
    const [v1] = storyboard.versions;
    assert.deepEqual(
      v1.keyframes.map((k) => [k.id, k.file, k.sha256, k.bytes]),
      Object.entries(V1).map(([id, text]) => [id, `Sent to YTM/H-0004/bar/${id}.jpg`, sha(text), Buffer.byteLength(text)])
    );
    assert.deepEqual(v1.segments.map((s) => s.id), ["S1", "S2", "S3", "S4"]);
    assert.deepEqual(v1.segments[1], { id: "S2", fromKeyframeId: "K1", toKeyframeId: "K2", action: "she drinks and puts the glass down", durationSeconds: 8, model: null, settings: {}, estimateUsd: null });
    assert.deepEqual(v1.props.map((p) => p.id), ["glass", "towel", "cup", "saucer"]);
    assert.equal(v1.notes, "background nearly still, no gusts, nobody talks");

    const submitted = await service.submit({ channelId: CH, storyboardId: "bar-loop" });
    assert.equal(submitted.storyboard.state, "in_review");
    assert.equal(submitted.alreadySubmitted, false);
    // Submitting the same version again changes nothing (its submission time stays).
    const again = await service.submit({ channelId: CH, storyboardId: "bar-loop" });
    assert.equal(again.alreadySubmitted, true);
    assert.equal(again.storyboard.submittedAt, submitted.storyboard.submittedAt);
    assert.deepEqual((await service.list({ channelId: CH, state: "in_review" })).storyboards.map((s) => s.storyboardId), ["bar-loop"]);
    assert.deepEqual((await service.list({ channelId: CH, state: "approved" })).storyboards, []);
  } finally {
    await cleanup();
  }
});

test("B1: a keyframe may also be a Gemini job's output in place (From YTM/gemini/<jobId>/...); a 2-keyframe loop has two segments", async () => {
  const { service, cleanup } = await setup();
  try {
    const { storyboard } = await service.create({
      channelId: CH,
      title: "Still pair",
      loop: true,
      keyframes: [
        { id: "A", file: "From YTM/gemini/gm_job1/image-1.png" },
        { id: "B", file: "Sent to YTM/H-0004/bar/K1.jpg", parentKeyframeId: "A" },
      ],
      segments: [
        { id: "AB", fromKeyframeId: "A", toKeyframeId: "B", action: "a", durationSeconds: 8 },
        { id: "BA", fromKeyframeId: "B", toKeyframeId: "A", action: "b", durationSeconds: 8 },
      ],
      props: [],
    });
    assert.match(storyboard.storyboardId, /^sb_/);
    assert.equal(storyboard.versions[0].keyframes[0].sha256, sha("gemini still"));
    assert.equal(storyboard.versions[0].keyframes[1].parentKeyframeId, "A");
  } finally {
    await cleanup();
  }
});

test("B1 refusals: the chain of segments, ids, prop cells, file locations and the channel -- nothing is stored", async () => {
  const { service, root, cleanup } = await setup();
  try {
    const base = barLoop();
    // Loop on without the closing K3 -> K0 segment; loop off with it; a segment that skips a keyframe; two for one pair.
    await code(service.create({ ...base, segments: base.segments.slice(0, 3) }), "validation_failed", { from: "K3", to: "K0" });
    await code(service.create({ ...base, loop: false }), "validation_failed", { segmentId: "S4" });
    await code(service.create({ ...base, segments: [...base.segments.slice(0, 3), { ...base.segments[3], fromKeyframeId: "K2", toKeyframeId: "K0" }] }), "validation_failed");
    await code(service.create({ ...base, segments: [...base.segments, { ...base.segments[0], id: "S1b" }] }), "validation_failed", { from: "K0", to: "K1" });
    await code(service.create({ ...base, keyframes: [...base.keyframes.slice(0, 3), { ...base.keyframes[3], id: "K0" }] }), "validation_failed", { id: "K0" });
    await code(service.create({ ...base, props: [{ id: "glass", name: "Glass", kind: "object", cells: { K9: "?" } }] }), "validation_failed", { keyframeId: "K9" });
    await code(service.create({ ...base, keyframes: base.keyframes.map((k) => (k.id === "K2" ? { ...k, parentKeyframeId: "K2" } : k)) }), "validation_failed", { keyframeId: "K2" });
    await code(service.create({ ...base, unknownField: true }), "validation_failed");
    // A file named without its exchange folder, outside it, through `..`, or not there at all.
    const withFile = (file: string) => ({ ...base, keyframes: base.keyframes.map((k) => (k.id === "K2" ? { ...k, file } : k)) });
    await code(service.create(withFile("H-0004/bar/K2.jpg")), "validation_failed", { keyframeId: "K2" });
    // A keyframe is a still image (png, jpg, jpeg, webp), whatever else the folder holds.
    await writeFile(path.join(root, "Tropico Jazz", "99 Data Exchange", "Sent to YTM", "H-0004", "bar", "clip.mp4"), "video");
    await code(service.create(withFile("Sent to YTM/H-0004/bar/clip.mp4")), "validation_failed", { keyframeId: "K2" });
    await code(service.create(withFile("Sent to YTM/../../outside.jpg")), "storyboard_file_unavailable", { keyframeId: "K2" });
    await code(service.create(withFile(path.join(root, "outside.jpg"))), "validation_failed", { keyframeId: "K2" });
    await code(service.create(withFile("Sent to YTM/H-0004/bar/K9.jpg")), "storyboard_file_unavailable", { keyframeId: "K2" });
    await code(service.create(withFile("From YTM/other/gm_job1/image-1.png")), "storyboard_file_unavailable", { keyframeId: "K2" });
    assert.deepEqual((await service.list({ channelId: CH })).storyboards, []);
    // An existing id is refused.
    await service.create(base);
    await code(service.create(base), "validation_failed");
  } finally {
    await cleanup();
  }
  for (const options of [{ connected: false }, { workspace: false }]) {
    const other = await setup(options);
    try {
      await code(other.service.create(barLoop()), "storyboard_channel_unavailable");
    } finally {
      await other.cleanup();
    }
  }
});

test("§5 step 2 (B2): the owner pins K2 ('where is the glass?'), comments on S2 and requests changes; a draft cannot be decided", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.create(barLoop());
    await code(service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 1 }), "storyboard_not_submitted");
    await service.submit({ channelId: CH, storyboardId: "bar-loop" });

    const pin = await service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "keyframe", keyframeId: "K2", region: { x: 0.41, y: 0.55, r: 0.06 } }, text: "where is the glass?" });
    const onS2 = await service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "segment", segmentId: "S2" }, text: "she should put it under the counter" });
    await service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "prop", propId: "glass", keyframeId: "K2" }, text: "empty cell" });
    await code(service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "keyframe", keyframeId: "K7" }, text: "x" }), "validation_failed");
    await code(service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "prop", propId: "lamp", keyframeId: "K1" }, text: "x" }), "validation_failed");
    await code(service.ownerComment(CH, "bar-loop", { versionNumber: 2, target: { kind: "storyboard" }, text: "x" }), "storyboard_version_not_latest");

    const decided = await service.ownerDecide(CH, "bar-loop", { kind: "changes_requested", versionNumber: 1, note: "fix the glass" });
    assert.equal(decided.state, "changes_requested");
    const detail = await service.getForOwner(CH, "bar-loop");
    assert.equal(detail.state, "changes_requested");
    assert.equal(detail.openComments, 3);
    const pinned = detail.comments.find((c) => c.id === pin.commentId)!;
    assert.deepEqual([pinned.author, pinned.device, pinned.versionNumber, pinned.state, pinned.target], ["owner", "Mac", 1, "open", { kind: "keyframe", keyframeId: "K2", region: { x: 0.41, y: 0.55, r: 0.06 } }]);
    assert.deepEqual(detail.lastDecision && [detail.lastDecision.kind, detail.lastDecision.versionNumber, detail.lastDecision.note], ["changes_requested", 1, "fix the glass"]);
    // The Operator sees the same through the API (FO-REQ C: factory_storyboard_list with state changes_requested).
    const { storyboards } = await service.list({ channelId: CH, state: "changes_requested" });
    assert.deepEqual(storyboards.map((s) => [s.storyboardId, s.openComments]), [["bar-loop", 3]]);
    assert.ok(detail.comments.some((c) => c.id === onS2.commentId && c.target.kind === "segment"));
  } finally {
    await cleanup();
  }
});

test("§5 step 3 (B3): v2 from bar/v2/, the Operator answers and resolves, submits; the screen's diff against v1; approval only of the latest", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.create(barLoop());
    await service.submit({ channelId: CH, storyboardId: "bar-loop" });
    const { commentId } = await service.ownerComment(CH, "bar-loop", { versionNumber: 1, target: { kind: "keyframe", keyframeId: "K2", region: { x: 0.4, y: 0.5, r: 0.05 } }, text: "where is the glass?" });
    await service.ownerDecide(CH, "bar-loop", { kind: "changes_requested", versionNumber: 1 });

    const updated = await service.update(barLoop("bar/v2", V2_GLASS));
    assert.deepEqual([updated.changed, updated.versionNumber, updated.storyboard.state], [true, 2, "draft"]);
    await service.operatorReply({ channelId: CH, storyboardId: "bar-loop", commentId, text: "v2: the glass stays under the counter", resolve: true });
    await code(service.operatorReply({ channelId: CH, storyboardId: "bar-loop", commentId }), "validation_failed");
    await code(service.operatorReply({ channelId: CH, storyboardId: "bar-loop", commentId: "c_nope", resolve: true }), "storyboard_comment_not_found");
    await service.submit({ channelId: CH, storyboardId: "bar-loop" });

    const { storyboard } = await service.get({ channelId: CH, storyboardId: "bar-loop" });
    assert.equal(storyboard.state, "in_review");
    const comment = storyboard.comments.find((c) => c.id === commentId)!;
    assert.deepEqual([comment.state, comment.stateChangedBy, comment.replies.map((r) => [r.author, r.text])], ["resolved", "operator", [["operator", "v2: the glass stays under the counter"]]]);
    // v1 stays readable with its own files and comments.
    assert.deepEqual(storyboard.versions.map((v) => v.number), [1, 2]);
    assert.equal(storyboard.versions[0].keyframes[1].sha256, sha(V1.K1));

    // What changed: K0's bytes are the same (only its folder moved), K1-K3 were replaced; the glass row changed in K1-K3.
    const diff = await service.versionDiff(CH, "bar-loop", 2);
    assert.deepEqual(diff, {
      keyframesReplaced: ["K1", "K2", "K3"],
      keyframesAdded: [],
      keyframesRemoved: [],
      segmentsChanged: [],
      segmentsAdded: [],
      segmentsRemoved: [],
      propCellsChanged: [
        { propId: "glass", keyframeId: "K1" },
        { propId: "glass", keyframeId: "K2" },
        { propId: "glass", keyframeId: "K3" },
      ],
      notesChanged: false,
    });
    assert.equal(await service.versionDiff(CH, "bar-loop", 1), null);

    // An approval names the version on the owner's screen: v1 is no longer the latest.
    await code(service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 1 }), "storyboard_version_not_latest", { latestVersion: 2 });
    assert.equal((await service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 2 })).state, "approved");
    // The same content again makes no version and keeps the approval.
    const same = await service.update(barLoop("bar/v2", V2_GLASS));
    assert.deepEqual([same.changed, same.versionNumber, same.storyboard.state], [false, 2, "approved"]);
    // Any edit after the approval is a new version that is not approved (B3).
    const edited = await service.update({ ...barLoop("bar/v2", V2_GLASS), segments: segments().map((s) => (s.id === "S3" ? { ...s, action: "he folds the towel" } : s)) });
    assert.deepEqual([edited.changed, edited.versionNumber, edited.storyboard.state], [true, 3, "draft"]);
    assert.deepEqual((await service.versionDiff(CH, "bar-loop", 3))?.segmentsChanged, ["S3"]);
    await service.submit({ channelId: CH, storyboardId: "bar-loop" });
    assert.equal((await service.getForOwner(CH, "bar-loop")).state, "in_review");
  } finally {
    await cleanup();
  }
});

test("plan §2.3: this computer's copy of a keyframe -- ok, differs (overwritten in place) or missing; a differing file is still shown", async () => {
  const { service, bar, cleanup } = await setup();
  try {
    await service.create(barLoop());
    assert.deepEqual(await service.keyframeFiles(CH, "bar-loop", 1), { K0: "ok", K1: "ok", K2: "ok", K3: "ok" });
    await writeFile(path.join(bar, "K1.jpg"), "overwritten in place");
    await rm(path.join(bar, "K3.jpg"));
    assert.deepEqual(await service.keyframeFiles(CH, "bar-loop", 1), { K0: "ok", K1: "differs", K2: "ok", K3: "missing" });
    assert.equal((await service.keyframeFile(CH, "bar-loop", 1, "K1"))?.bytes, Buffer.byteLength("overwritten in place"));
    assert.equal(await service.keyframeFile(CH, "bar-loop", 1, "K3"), null);
    await code(service.keyframeFile(CH, "bar-loop", 1, "K9"), "storyboard_not_found");
    await code(service.getForOwner(CH, "nope"), "storyboard_not_found");
  } finally {
    await cleanup();
  }
});

test("B2 prop table: a cell that differs from the previous keyframe's is highlighted (the first keyframe never is)", async () => {
  const { service, cleanup } = await setup();
  try {
    const { storyboard } = await service.create(barLoop());
    const changed = changedPropCells(storyboard.versions[0]);
    // By hand from V1_GLASS and the towel row: glass changes at K1, K2, K3; the towel at K2 and back at K3; cup and saucer never.
    assert.deepEqual([...changed].sort(), ["glass|K1", "glass|K2", "glass|K3", "towel|K2", "towel|K3"]);
  } finally {
    await cleanup();
  }
});

test("ADR 0038 §4: the approved version is the latest one only while its newest decision is an approval", async () => {
  const { service, cleanup } = await setup();
  try {
    await service.create(barLoop());
    await service.submit({ channelId: CH, storyboardId: "bar-loop" });
    await service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 1 });
    const record = async () => {
      const detail = await service.getForOwner(CH, "bar-loop");
      return {
        id: detail.storyboardId,
        createdAt: detail.createdAt,
        createdBy: detail.createdBy,
        planId: detail.planId,
        versions: Object.fromEntries(detail.versions.map((v) => [String(v.number), v])),
        submissions: Object.fromEntries(detail.submissions.map((s) => [String(s.versionNumber), { at: s.at }])),
        decisions: Object.fromEntries(detail.decisions.map((d) => [d.id, d])),
        comments: {},
      };
    };
    assert.equal(approvedVersion(await record())?.number, 1);
    // The owner changes their mind: the newest decision on the version counts.
    await service.ownerDecide(CH, "bar-loop", { kind: "changes_requested", versionNumber: 1 });
    assert.equal(approvedVersion(await record()), null);
    await service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 1 });
    assert.equal(approvedVersion(await record())?.number, 1);
  } finally {
    await cleanup();
  }
});
