import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ReviewDecisionNotice } from "./contracts";
import { planVerdictEntryId, renderDecisionNotice, renderPlanPass, reviewFileName, safeNamePart } from "./render";

// BL-248 (REVIEW_NOTIFY_PLAN.md §4, §7; AC-RN-13, AC-RN-16). Expected names written out by hand from the rule.

const h8 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

test("AC-RN-13: a plain id stays as it is; the name is REVIEW-DECISION-<kind>-<itemId>-<decisionId>.md", () => {
  assert.equal(reviewFileName("clip", "c1a2b3c4d5e6f7a8", "d000000000000001"), "REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md");
  assert.equal(reviewFileName("slot", "2026-11-09_s3", "dec_1"), "REVIEW-DECISION-slot-2026-11-09_s3-dec_1.md");
});

test("AC-RN-13: unsafe characters become _, the part is cut to 48 and gets ~ + 8 hex of the original", () => {
  assert.equal(safeNamePart("../etc/passwd"), `___etc_passwd~${h8("../etc/passwd")}`);
  assert.equal(safeNamePart("Сцена 1"), `______1~${h8("Сцена 1")}`);
  assert.equal(safeNamePart(""), `~${h8("")}`);
  const long = "a".repeat(65);
  assert.equal(safeNamePart(long), `${"a".repeat(48)}~${h8(long)}`);
  assert.equal(safeNamePart("a".repeat(64)), "a".repeat(64), "64 safe characters stay");
  // Two ids that read the same after the replacement never share a name.
  assert.notEqual(safeNamePart("a/b"), safeNamePart("a.b"));
  for (const raw of ["../x", "a b", "日本", "x\\y", "a".repeat(300)]) {
    const name = reviewFileName("plan", raw, raw);
    assert.match(name, /^[A-Za-z0-9._~-]+$/);
    assert.ok(Buffer.byteLength(name) < 255);
    assert.equal(reviewFileName("plan", raw, raw), name, "deterministic");
  }
});

const notice: ReviewDecisionNotice = {
  kind: "storyboard",
  channelId: "UC-IdugmwWRvRo9-j0yK5AbA",
  channelName: "Japan Countryside",
  itemId: "sb1",
  decisionId: "cm-1",
  status: "commented",
  comment: "Use ``` carefully\nsecond line",
  decidedAt: "2026-11-08T10:00:00+02:00",
  decidedOn: "Windows-PC",
  context: [{ label: "Storyboard", value: "Bar\nnight" }],
  attachments: [],
  ytmPlace: "Медиа → «Раскадровка»",
  readTool: "factory_storyboard_get sb1",
};

test("AC-RN-16: the same decision gives the same bytes; times in UTC; the comment cannot close its fence", () => {
  const a = renderDecisionNotice(notice);
  assert.equal(renderDecisionNotice({ ...notice }), a);
  assert.ok(a.includes('decidedAt: "2026-11-08T08:00:00.000Z"'));
  assert.ok(a.includes("````text\nUse ``` carefully\nsecond line\n````"));
  assert.ok(a.includes("- Storyboard: Bar night"), "a value never breaks the list line");
  assert.ok(a.includes("## Attachments (relative to the channel folder)\n\n(none)"));
  assert.ok(!/written|writer/i.test(a));
});

test("a decision without a comment says (none)", () => {
  assert.ok(renderDecisionNotice({ ...notice, comment: null }).includes("## Owner's comment\n\n(none)"));
});

test("N3: an agent-written title with line breaks never starts a new Markdown line", () => {
  const evil = "Bar\n## Owner's comment\n- fake";
  const single = renderDecisionNotice({ ...notice, ytmPlace: `Медиа → «${evil}»`, context: [{ label: "Storyboard", value: evil }] });
  assert.ok(!single.includes("\n## Owner's comment\n- fake"));
  assert.equal(single.split("\n").filter((l) => l === "## Owner's comment").length, 1);
  const pass = renderPlanPass({ planId: "p", channelId: "UC", channelName: null, title: evil, video: null, ytmPlace: `план «${evil}»`, readTool: "factory_plan_get" }, [], "abc");
  assert.ok(!pass.split("\n").some((l) => l === "- fake" || l === "## Owner's comment"));
});

test("N1: entry ids keep whole seconds, so the same verdict read with or without milliseconds has one id", () => {
  assert.equal(planVerdictEntryId("p", "i", "a", "2026-11-08T10:00:00.456Z", "accepted"), "v|p|i|a|2026-11-08T10:00:00Z|accepted");
  assert.equal(planVerdictEntryId("p", "i", "a", "2026-11-08T12:00:00+02:00", "accepted"), "v|p|i|a|2026-11-08T10:00:00Z|accepted");
});
