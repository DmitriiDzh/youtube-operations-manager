import assert from "node:assert/strict";
import test from "node:test";
import type { PlanReviewActivity } from "@/lib/generation-plans";
import type { ClipReviewsSnapshot, PublishingPlansSnapshot, SharedPlan, StoryboardRecord } from "@/lib/sync-gateway";
import { clipNoticesOf, planFeedOfActivity, planFeedOfPeerPlan, slotNoticesOf, storyboardNoticesOf } from "./review-notify";

// BL-248 (REVIEW_NOTIFY_PLAN.md §2): only the owner's decisions become notices -- never the Producer's withdrawal or submit, never
// the Operator's comments or replies. Expected values written out by hand from §2 / §4.

const CH = { channelId: "UCa2amtpeOmgP-HkiLKPm1gg", name: "Tropico Jazz" };
const SINCE = Date.parse("2026-11-08T00:00:00Z");

test("AC-RN-01/02: clips -- owner approved and returned give notices; the Producer's withdrawal and a pending clip give none", () => {
  const clip = (clipId: string) => ({ clipId, channelId: CH.channelId, sceneId: `scene ${clipId}`, clipPath: `03 Images/${clipId}.mp4`, note: "n", startSec: null, endSec: null, durationSeconds: 20, sizeBytes: 1, sha256: "x", submittedAt: "2026-11-08T08:00:00Z", submittedBy: "p", device: "Mac" });
  const snapshot: ClipReviewsSnapshot = {
    clips: { c1: clip("c1"), c2: clip("c2"), c3: clip("c3"), c4: clip("c4") },
    decisions: {
      d1: { id: "d1", clipId: "c1", kind: "returned", by: "owner", comment: "Темно", device: "Mac", at: "2026-11-08T09:30:00Z", attachments: [{ path: "99 Data Exchange/From YTM/clip-reviews/c1/d1/a.png", name: "a.png", mime: "image/png", size: 3, sha256: "s" }] },
      d2: { id: "d2", clipId: "c2", kind: "approved", by: "owner", comment: null, device: "Win", at: "2026-11-08T09:31:00Z" },
      d3: { id: "d3", clipId: "c3", kind: "withdrawn", by: "producer", comment: null, device: "Mac", at: "2026-11-08T09:32:00Z" },
      old: { id: "old", clipId: "c4", kind: "approved", by: "owner", comment: null, device: "Mac", at: "2026-11-07T23:59:59Z" },
    },
  };
  const notices = clipNoticesOf(CH, snapshot, SINCE);
  assert.deepEqual(notices.map((n) => [n.itemId, n.decisionId, n.status, n.comment, n.decidedOn]).sort(), [
    ["c1", "d1", "returned", "Темно", "Mac"],
    ["c2", "d2", "approved", null, "Win"],
  ]);
  const returned = notices.find((n) => n.decisionId === "d1")!;
  assert.deepEqual(returned.attachments, ["99 Data Exchange/From YTM/clip-reviews/c1/d1/a.png"]);
  assert.deepEqual(returned.context.slice(0, 2), [
    { label: "Scene", value: "scene c1" },
    { label: "Clip file", value: "03 Images/c1.mp4" },
  ]);
  assert.equal(returned.channelName, "Tropico Jazz");
  assert.equal(returned.ytmPlace, "Медиа → «Клипы»");
  assert.equal(returned.readTool, 'producer_clip_review_get {"channelId":"UCa2amtpeOmgP-HkiLKPm1gg","clipId":"c1"}');
});

function storyboard(): StoryboardRecord {
  return {
    id: "sb_1",
    createdAt: "2026-11-01T00:00:00Z",
    createdBy: "operator",
    planId: null,
    video: "V62",
    versions: { "1": { number: 1, createdAt: "2026-11-01T00:00:00Z", title: "Бар ночью", loop: true, keyframes: [], segments: [], props: [], notes: null, contentHash: "h1" } },
    submissions: { "1": { at: "2026-11-08T01:00:00Z", contentHash: "h1" } },
    decisions: { d_1: { id: "d_1", kind: "changes_requested", versionNumber: 1, contentHash: "h1", by: "owner", device: "Mac", at: "2026-11-08T02:00:00Z", note: "Свет теплее" } },
    comments: {
      c_owner: {
        id: "c_owner",
        versionNumber: 1,
        target: { kind: "keyframe", keyframeId: "k1", region: { x: 0.5, y: 0.5, r: 0.1 } },
        author: "owner",
        device: "Mac",
        text: "Лампа",
        createdAt: "2026-11-08T02:01:00Z",
        state: "open",
        stateChangedAt: null,
        stateChangedBy: null,
        replies: { r_op: { id: "r_op", author: "operator", device: null, text: "Сделаю", createdAt: "2026-11-08T02:05:00Z" } },
      },
      c_op: {
        id: "c_op",
        versionNumber: 1,
        target: { kind: "storyboard" },
        author: "operator",
        device: null,
        text: "Вопрос",
        createdAt: "2026-11-08T02:02:00Z",
        state: "open",
        stateChangedAt: null,
        stateChangedBy: null,
        replies: { r_owner: { id: "r_owner", author: "owner", device: "Win", text: "Да", createdAt: "2026-11-08T02:06:00Z" } },
      },
    },
    renders: { rn_1: { id: "rn_1", versionNumber: 1, contentHash: "h1", file: "Sent to YTM/loop.mp4", sha256: "s", bytes: 1, picks: {}, notes: null, createdAt: "2026-11-08T03:00:00Z", device: null } },
    renderDecisions: { rd_1: { id: "rd_1", renderId: "rn_1", kind: "approved", by: "owner", device: "Mac", at: "2026-11-08T03:10:00Z", note: null } },
  };
}

test("AC-RN-03: storyboards -- the owner's decision, comment and reply, and his render verdict; the Operator's comment and reply never", () => {
  const notices = storyboardNoticesOf(CH, [storyboard()], SINCE);
  assert.deepEqual(notices.map((n) => [n.kind, n.decisionId, n.status, n.comment]).sort(), [
    ["render", "rd_1", "approved", null],
    ["storyboard", "c_owner", "commented", "Лампа"],
    ["storyboard", "d_1", "changes_requested", "Свет теплее"],
    ["storyboard", "r_owner", "replied", "Да"],
  ]);
  const comment = notices.find((n) => n.decisionId === "c_owner")!;
  assert.ok(comment.context.some((l) => l.label === "On" && l.value === "keyframe k1 (region x=0.5 y=0.5 r=0.1)"));
  assert.ok(comment.context.some((l) => l.label === "Storyboard" && l.value === "Бар ночью"));
  assert.ok(comment.context.some((l) => l.label === "Video" && l.value === "V62"));
  const reply = notices.find((n) => n.decisionId === "r_owner")!;
  assert.ok(reply.context.some((l) => l.label === "Reply to" && l.value === "operator's comment c_op: Вопрос"));
  assert.equal(reply.itemId, "sb_1");
  const render = notices.find((n) => n.kind === "render")!;
  assert.ok(render.context.some((l) => l.label === "File (in 99 Data Exchange)" && l.value === "Sent to YTM/loop.mp4"));
});

test("AC-RN-04: slots -- every owner decision with itemId <weekStart>_<slotId>", () => {
  const snapshot: PublishingPlansSnapshot = {
    plans: {},
    slots: {},
    decisions: {
      pd1: { id: "pd1", weekStart: "2026-11-09", slotId: "s3", kind: "vetoed", contentHash: "h", snapshot: { date: "2026-11-11", publishAt: "2026-11-11T18:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo" }, by: "owner", device: "Mac", at: "2026-11-08T10:00:00Z" },
      pd2: { id: "pd2", weekStart: "2026-11-09", slotId: "s4", kind: "approved", contentHash: "h", snapshot: { date: "2026-11-12", publishAt: "2026-11-12T18:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo" }, by: "owner", device: "Mac", at: "2026-11-07T10:00:00Z" },
    },
  };
  const notices = slotNoticesOf(CH, snapshot, SINCE);
  assert.deepEqual(notices.map((n) => [n.itemId, n.decisionId, n.status]), [["2026-11-09_s3", "pd1", "vetoed"]]);
  assert.ok(notices[0].context.some((l) => l.label === "Publish at" && l.value === "2026-11-11T18:00 (Asia/Tokyo)"));
});

test("plans -- this computer's verdict history, picks and «ни один не подходит» with stable entry ids", () => {
  const activity: PlanReviewActivity = {
    planId: "plan-1",
    channelId: CH.channelId,
    title: "Stills",
    video: "V61",
    groupOf: { i1: "w1", i2: "w1" },
    history: [{ itemKey: "i1", attemptRef: "a1", result: "rejected", rating: 3, note: "Шум", device: "Mac", at: "2026-11-08T10:00:00Z", reasons: ["шум"], markers: [{ start: 0, end: null, note: "тут", region: { x: 0.1, y: 0.2, r: 0.05 } }] }],
    picks: [
      { itemKey: "i2", kind: "pick", attemptRef: "a2", active: true, note: null, device: "Win", at: "2026-11-08T10:01:00Z", covered: [] },
      { itemKey: "i3", kind: "none_fits", attemptRef: null, active: true, note: "Нет", device: "Win", at: "2026-11-08T10:02:00Z", covered: [] },
    ],
    waveFinishedAt: ["2026-11-08T10:02:00Z"],
  };
  const feed = planFeedOfActivity(activity, "Tropico Jazz");
  assert.deepEqual(
    feed.entries.map((e) => e.entryId),
    ["v|plan-1|i1|a1|2026-11-08T10:00:00.000Z|rejected", "p|plan-1|i2|a2|2026-11-08T10:01:00.000Z", "n|plan-1|i3|2026-11-08T10:02:00.000Z"]
  );
  assert.deepEqual(feed.entries[0].marks, [{ start: 0, end: null, note: "тут", region: { x: 0.1, y: 0.2, r: 0.05 } }]);
  assert.equal(feed.entries[0].groupId, "w1");
  assert.deepEqual(feed.waveFinishedAt, ["2026-11-08T10:02:00Z"]);
});

test("plans -- the other computer's report: history verdicts (with the current row's reasons and marks), picks, none fits, waves", () => {
  const row = (result: "accepted" | "rejected", at: string, reportedBy = "owner") => ({ stageId: "review", itemKey: "i1", attemptRef: "a1", result, reportedBy, note: null, rating: 6, reasons: ["цвет"], markers: [{ start: 1, end: 2, note: null }], auditionFile: null, checks: [], metrics: {}, referenceIds: [], at });
  const plan = {
    planId: "plan-w",
    title: "Win plan",
    channelId: CH.channelId,
    items: [{ itemKey: "i1", groupId: "g1", templateLabel: null, targetCount: 1, mode: "fixed" }],
    review: [
      {
        itemKey: "i1",
        groupId: "g1",
        attemptRef: "a1",
        jobId: null,
        seed: null,
        params: {},
        stages: [],
        verdict: row("accepted", "2026-11-08T11:00:00Z"),
        playable: true,
        jobOutput: null,
        history: [
          { result: "rejected", rating: 2, note: "old", device: "Win", at: "2026-11-07T11:00:00Z" },
          { result: "accepted", rating: 6, note: "ok", device: "Win", at: "2026-11-08T11:00:00Z" },
        ],
      },
    ],
    picks: [],
    noneFits: [{ itemKey: "i1", note: null, device: "Mac", at: "2026-11-08T11:05:00Z", attempts: 2 }],
    events: [{ at: "2026-11-08T11:00:01Z", kind: "group_reviewed", actor: "owner", details: {} }, { at: "2026-11-08T11:00:02Z", kind: "job_done", actor: "factory", details: {} }],
  } as unknown as SharedPlan;
  const feed = planFeedOfPeerPlan(plan, null, SINCE);
  assert.deepEqual(
    feed.entries.map((e) => e.entryId),
    ["v|plan-w|i1|a1|2026-11-08T11:00:00.000Z|accepted", "n|plan-w|i1|2026-11-08T11:05:00.000Z"]
  );
  assert.deepEqual(feed.entries[0].reasons, ["цвет"]);
  assert.deepEqual(feed.entries[0].marks, [{ start: 1, end: 2, note: null, region: null }]);
  assert.deepEqual(feed.waveFinishedAt, ["2026-11-08T11:00:01Z"]);
});
