import assert from "node:assert/strict";
import test from "node:test";
import { actionsOf, decisionBody, decisionReady, durationLabel, issueLabel, mediaSrcOf, newCommentId, nextMoment, notesCount, withIssueAction, withoutIssueAction, oneLineText, returnCommentReady, withComment, withEditedComment, withoutComment } from "./package-reviews-model";
import { frameOf } from "./media-frame";
import { flagPlaces, PLAYBACK_RATES, playerKeyAction, rateKeyDirection, seekTarget, stepRate, storedRate } from "./visual-review-model";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-04/05/09/15; ADR 0070 §4, §6): the screen asks for the media by the manifest hash only; the
// owner may change his mind until the upload; approval needs the manifest's video checksum; a return needs a comment; a vertical
// video keeps its 9:16 frame.

test("media address: by manifest hash, never a path", () => {
  assert.equal(mediaSrcOf("/api/channels/UC_1/package-reviews", "a".repeat(64), "video"), `/api/channels/UC_1/package-reviews/video?manifest=${"a".repeat(64)}`);
  assert.equal(mediaSrcOf("/b", "f0", "thumbnail"), "/b/thumbnail?manifest=f0");
});

test("durations", () => {
  assert.deepEqual([durationLabel(58), durationLabel(754), durationLabel(3725), durationLabel(0)], ["0:58", "12:34", "1:02:05", "0:00"]);
});

// BL-265 (AC-MG-07): every package also offers «Комментарий к упаковке», uploaded ones included.
test("AC-PR-04/05, AC-MG-07: actions by state", () => {
  assert.deepEqual(actionsOf({ state: "pending", hasVideoSha256: true }), { approve: true, reapprove: false, ret: true, comment: true });
  assert.deepEqual(actionsOf({ state: "pending", hasVideoSha256: false }), { approve: false, reapprove: false, ret: true, comment: true });
  assert.deepEqual(actionsOf({ state: "approved", hasVideoSha256: true }), { approve: false, reapprove: true, ret: true, comment: true });
  // Owner TG 4836 (changed requirement: approve again with notes): an approved video offers «approve again with notes», never without the checksum.
  assert.equal(actionsOf({ state: "approved", hasVideoSha256: false }).reapprove, false);
  assert.deepEqual(actionsOf({ state: "returned", hasVideoSha256: true }), { approve: true, reapprove: false, ret: false, comment: true });
  assert.deepEqual(actionsOf({ state: "uploaded", hasVideoSha256: true }), { approve: false, reapprove: false, ret: false, comment: true });
  assert.deepEqual([returnCommentReady(""), returnCommentReady("  \n"), returnCommentReady(" x ")], [false, false, true]);
});

// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01/03/05/06): the screen's draft edits keep the comments in time order with one decimal;
// a return can go with comments at moments instead of a general comment; the decision's body carries them without the screen's ids,
// and never with a packaging comment.
test("AC-TC-01/03: adding keeps time order and one decimal; editing changes only the text; deleting removes one", () => {
  const a = withComment([], { id: "a", atSeconds: 61.26, text: "  logo late " });
  const b = withComment(a, { id: "b", atSeconds: 4, text: "black frame" });
  assert.deepEqual(b, [
    { id: "b", atSeconds: 4, text: "black frame" },
    { id: "a", atSeconds: 61.3, text: "logo late" },
  ]);
  assert.deepEqual(withComment(b, { id: "c", atSeconds: 10, text: "   " }), b, "an empty text adds nothing");
  assert.deepEqual(withEditedComment(b, "a", "logo too late"), [b[0], { id: "a", atSeconds: 61.3, text: "logo too late" }]);
  assert.deepEqual(withEditedComment(b, "a", "  "), b, "an empty edit keeps the text");
  assert.deepEqual(withoutComment(b, "b"), [{ id: "a", atSeconds: 61.3, text: "logo late" }]);
  assert.equal(oneLineText("one\ntwo\r\nthree"), "one two three");
  assert.match(newCommentId(() => 0.5), /^[A-Za-z0-9_-]{1,40}$/);
});

test("AC-TC-05/06: what can be sent and what the decision carries", () => {
  assert.deepEqual([decisionReady("approved", "", 0), decisionReady("returned", "", 0), decisionReady("returned", "", 2), decisionReady("returned", "redo", 0)], [true, false, true, true]);
  assert.deepEqual([decisionReady("packaging_comment", "", 3), decisionReady("packaging_comment", "title", 0)], [false, true]);
  // Owner TG 4836: approving an approved video again needs notes -- a general comment or a comment at a moment.
  assert.deepEqual([decisionReady("approved", "", 0, true), decisionReady("approved", " next time shorter intro ", 0, true), decisionReady("approved", "", 1, true)], [false, true, true]);
  const draft = [{ id: "a", atSeconds: 4, text: "black frame" }];
  // Review fix 1 (changed requirement): an approval or a return names the draft it was made from (its server stamp; null: none).
  assert.deepEqual(decisionBody("m", "returned", "  ", draft, "2026-11-24T10:00:00.000Z"), { manifestSha256: "m", kind: "returned", comment: null, timedComments: [{ atSeconds: 4, text: "black frame" }], draftUpdatedAt: "2026-11-24T10:00:00.000Z" });
  assert.deepEqual(decisionBody("m", "approved", " ok ", []), { manifestSha256: "m", kind: "approved", comment: "ok", draftUpdatedAt: null });
  assert.deepEqual(decisionBody("m", "packaging_comment", "title", draft), { manifestSha256: "m", kind: "packaging_comment", comment: "title" });
});

// Review fix 3 (AC-TC-01): focusing with nothing typed takes the current moment; playing on or seeking drops it, so a focus at 0:10,
// play to 2:00, pause, focus gives 2:00 -- never 0:10.
test("review fix 3: the moment a comment gets", () => {
  let at: number | null = null;
  at = nextMoment(at, { kind: "focus", text: "", current: 10 });
  assert.equal(at, 10);
  at = nextMoment(at, { kind: "play" });
  assert.equal(at, null);
  at = nextMoment(at, { kind: "focus", text: "", current: 120 });
  assert.equal(at, 120);
  assert.equal(nextMoment(120, { kind: "focus", text: "half typed", current: 130 }), 120, "refocusing a started comment keeps its moment");
  assert.equal(nextMoment(120, { kind: "focus", text: "  ", current: 130 }), 130, "nothing typed: the moment now");
  assert.equal(nextMoment(120, { kind: "seek" }), null);
  assert.equal(nextMoment(null, { kind: "focus", text: "typed earlier", current: 140 }), 140);
  assert.equal(nextMoment(120, { kind: "retake", current: 150 }), 150);
});

// AC-TC-02: flags never cover each other in a row -- the next one goes up a row; one past the right edge ends at its moment.
test("AC-TC-02: flag places on the timeline", () => {
  // 100 s over 1000 px, 150 px flags: 10 s -> 100 px, 12 s -> 120 px (overlaps -> row 1), 40 s -> 400 px (row 0 again), 95 s -> ends at 950.
  assert.deepEqual(flagPlaces([10, 12, 40, 95], 100, 1000, 150), [
    { left: 100, row: 0, side: "start" },
    { left: 120, row: 1, side: "start" },
    { left: 400, row: 0, side: "start" },
    { left: 800, row: 0, side: "end" },
  ]);
  // More overlaps than rows share the top row.
  assert.deepEqual(flagPlaces([1, 1, 1, 1], 100, 1000, 150, 3).map((p) => p.row), [0, 1, 2, 2]);
  assert.deepEqual(flagPlaces([5], 0, 1000, 26), [{ left: 0, row: 0, side: "start" }]);
});

test("AC-PR-15: the frame follows the video's own size", () => {
  assert.deepEqual([frameOf(1080, 1920), frameOf(1920, 1080), frameOf(0, 0)], ["vertical", "horizontal", "horizontal"]);
});

// Owner TG 4844: the speeds 0.25x / 0.5x (frame checks), 1x, 1.25x, 1.5x, 2x, 3x; `<` / `>` step one speed and stop at the ends; a
// remembered speed is used only when it is one of the list.
test("TG 4844: playback speeds, stepping and the remembered speed", () => {
  assert.deepEqual([...PLAYBACK_RATES], [0.25, 0.5, 1, 1.25, 1.5, 2, 3]);
  assert.equal(stepRate(1, 1), 1.25);
  assert.equal(stepRate(1.5, 1), 2);
  assert.equal(stepRate(2, 1), 3);
  assert.equal(stepRate(3, 1), 3, "the fastest stays");
  assert.equal(stepRate(1, -1), 0.5);
  assert.equal(stepRate(0.25, -1), 0.25, "the slowest stays");
  assert.equal(stepRate(1.75, 1), 1.25, "an unknown speed counts as 1x");
  assert.deepEqual([storedRate("1.5"), storedRate("3"), storedRate("4"), storedRate("abc"), storedRate(""), storedRate(null)], [1.5, 3, null, null, null, null]);
});

// TG 4844 / advisor review: `<` / `>` also by the physical key, so a Russian layout (where Shift + that key types «Б» / «Ю») works.
test("TG 4844: the speed keys on any layout", () => {
  assert.equal(rateKeyDirection({ key: "<", code: "Comma", shiftKey: true }), -1);
  assert.equal(rateKeyDirection({ key: ">", code: "Period", shiftKey: true }), 1);
  assert.equal(rateKeyDirection({ key: "Б", code: "Comma", shiftKey: true }), -1);
  assert.equal(rateKeyDirection({ key: "Ю", code: "Period", shiftKey: true }), 1);
  assert.equal(rateKeyDirection({ key: "б", code: "Comma", shiftKey: false }), null, "without Shift it is the frame step key");
  assert.equal(rateKeyDirection({ key: "a", code: "KeyA", shiftKey: true }), null);
});

// Owner TG 4856: ← / → seek 5 s (clamped to the clip), Space plays / pauses -- on the review screen, in full screen, with the focus or
// as the only open video; never while typing; `<` / `>` keep stepping the speed; `,` / `.` (frame steps) are not taken.
test("TG 4856: the watching keys", () => {
  const key = (k: string, code = "", over: Record<string, boolean> = {}) => ({ key: k, code, shiftKey: false, ...over });
  const page = { tag: "BODY", editable: false };
  const alone = { full: false, focused: false, alone: true, seekKeys: true };
  assert.deepEqual(playerKeyAction(key("ArrowLeft"), page, alone), { kind: "seek", delta: -5 });
  assert.deepEqual(playerKeyAction(key("ArrowRight"), page, { ...alone, alone: false, focused: true }), { kind: "seek", delta: 5 });
  assert.deepEqual(playerKeyAction(key("ArrowRight"), page, { full: true, focused: false, alone: false, seekKeys: true }), { kind: "seek", delta: 5 });
  assert.deepEqual(playerKeyAction(key(" ", "Space"), page, alone), { kind: "toggle" });
  assert.equal(playerKeyAction(key("ArrowLeft"), { tag: "INPUT", editable: false }, alone), null, "typing a comment");
  assert.equal(playerKeyAction(key("ArrowLeft"), { tag: "TEXTAREA", editable: false }, alone), null);
  assert.equal(playerKeyAction(key("ArrowLeft"), { tag: "DIV", editable: true }, alone), null);
  assert.equal(playerKeyAction(key("ArrowLeft"), page, { ...alone, alone: false }), null, "another video open, nothing focused");
  assert.equal(playerKeyAction(key("ArrowLeft"), page, { ...alone, seekKeys: false, focused: true }), null, "a screen without the watching keys");
  assert.equal(playerKeyAction(key("ArrowLeft", "", { metaKey: true }), page, alone), null);
  assert.equal(playerKeyAction(key(","), page, alone), null, "the frame step stays the screen's");
  assert.deepEqual(playerKeyAction({ key: "Ю", code: "Period", shiftKey: true }, page, { ...alone, focused: true }), { kind: "rate", direction: 1 });
  // Clamped to 0 and to the length.
  assert.deepEqual([seekTarget(3, -5, 100), seekTarget(97, 5, 100), seekTarget(50, 5, 100), seekTarget(10, 5, Number.NaN)], [0, 100, 55, 15]);
});

// Owner TG 4846 (AC-IS-04): one draft action per issue (the latest replaces), a follow-up needs a text, undo removes it; the decision
// carries them; resolves are no reason for a return, follow-ups are.
test("AC-IS-04: draft issue actions and what they count for", () => {
  let a = withIssueAction([], { issueId: "pr_a.1", kind: "resolved" });
  a = withIssueAction(a, { issueId: "pr_a.2", kind: "follow_up", text: " still\nthere " });
  assert.deepEqual(a, [{ issueId: "pr_a.1", kind: "resolved" }, { issueId: "pr_a.2", kind: "follow_up", text: "still there" }]);
  assert.deepEqual(withIssueAction(a, { issueId: "pr_a.3", kind: "follow_up", text: "  " }), a, "an empty follow-up adds nothing");
  assert.deepEqual(withIssueAction(a, { issueId: "pr_a.1", kind: "follow_up", text: "no, again" }).filter((x) => x.issueId === "pr_a.1"), [{ issueId: "pr_a.1", kind: "follow_up", text: "no, again" }]);
  assert.deepEqual(withoutIssueAction(a, "pr_a.1"), [{ issueId: "pr_a.2", kind: "follow_up", text: "still there" }]);
  assert.equal(notesCount([], a), 1);
  assert.deepEqual(decisionBody("m", "returned", "", [], null, a).issueActions, [{ issueId: "pr_a.1", kind: "resolved" }, { issueId: "pr_a.2", kind: "follow_up", text: "still there" }]);
  assert.equal("issueActions" in decisionBody("m", "packaging_comment", "t", [], null, a), false);
  assert.deepEqual([issueLabel(0), issueLabel(11)], ["I1", "I12"]);
});

// Independent review 2 #2 / #3: a hidden player (its tab not shown) takes no key; Space / K on a focused button, switch or link is that
// control's (no toggle), while the arrows still seek.
test("review 2: hidden players and focused controls", () => {
  const space = { key: " ", code: "Space", shiftKey: false };
  const alone = { full: false, focused: false, alone: true, seekKeys: true };
  assert.equal(playerKeyAction({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: false }, { tag: "BODY", editable: false }, { ...alone, rendered: false }), null);
  assert.equal(playerKeyAction(space, { tag: "BODY", editable: false }, { ...alone, rendered: false }), null);
  assert.equal(playerKeyAction(space, { tag: "BUTTON", editable: false }, { ...alone, focused: true }), null);
  assert.equal(playerKeyAction({ key: "k", code: "KeyK", shiftKey: false }, { tag: "BUTTON", editable: false }, { full: true, focused: true, alone: false, seekKeys: true }), null);
  assert.equal(playerKeyAction(space, { tag: "A", editable: false }, { ...alone, focused: true }), null);
  assert.equal(playerKeyAction(space, { tag: "SPAN", editable: false, role: "switch" }, { ...alone, focused: true }), null);
  assert.deepEqual(playerKeyAction(space, { tag: "DIV", editable: false }, { ...alone, focused: true }), { kind: "toggle" });
  assert.deepEqual(playerKeyAction({ key: "ArrowRight", code: "ArrowRight", shiftKey: false }, { tag: "BUTTON", editable: false }, { ...alone, focused: true }), { kind: "seek", delta: 5 });
});
