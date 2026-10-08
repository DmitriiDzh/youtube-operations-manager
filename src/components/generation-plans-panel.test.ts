import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import * as panel from "./generation-plans-panel";

// BL-143 (GENERATION_PLANS_PLAN.md §3): how the Plans tab words the derived numbers.

// BL-152: the words are translated; the requirement checked here is the English wording.
const t = createTranslator("en");
const describeStage = (...args: Parameters<typeof panel.describeStage> extends [unknown, ...infer R] ? R : never) => panel.describeStage(t, ...args);
const formatEta = (seconds: number | null) => panel.formatEta(t, seconds);
const describeEvent = (event: Parameters<typeof panel.describeEvent>[1]) => panel.describeEvent(t, event);

const counts = (over: Partial<Record<string, number>>) => ({ planned: 10, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0, accepted: 0, rejected: 0, ...over });

test("a generate stage's bar counts done jobs of the plan's target; a review stage's bar counts accepted (and done)", () => {
  assert.deepEqual(describeStage("in_app", counts({ done: 4, running: 1, failed: 2 })), { value: 4, total: 10, percent: 40, words: "done 4 · running 1 · failed 2" });
  assert.deepEqual(describeStage("owner_review", counts({ accepted: 3, rejected: 5 })), { value: 3, total: 10, percent: 30, words: "accepted 3 · rejected 5" });
  assert.equal(describeStage("external", counts({})).words, "nothing yet");
  assert.equal(describeStage("in_app", counts({ planned: 2, done: 5 })).percent, 100, "never over 100 %");
  assert.equal(describeStage("in_app", counts({ planned: 0 })).percent, 0);
});

test("the time left is in minutes, then hours and minutes; unknown is a dash", () => {
  assert.equal(formatEta(null), "—");
  assert.equal(formatEta(30), "under a minute");
  assert.equal(formatEta(380), "about 6 min");
  assert.equal(formatEta(4800), "about 1 h 20 min");
});

test("events read as one line: a stopped session says why, a verdict says the rating", () => {
  assert.equal(describeEvent({ at: "", kind: "session_stopped", actor: "app", details: { stopReason: "released after last job (1 min after the last job finished)" } }), "session stopped -- released after last job (1 min after the last job finished)");
  assert.equal(describeEvent({ at: "", kind: "owner_verdict", actor: "owner", details: { itemKey: "C8/U04", result: "rejected", rating: 6 } }), "your verdict C8/U04: rejected 6/10");
  assert.equal(describeEvent({ at: "", kind: "job_interrupted", actor: "app", details: { itemKey: "C6/F1", error: "interrupted by a server restart" } }), "job interrupted C6/F1: interrupted by a server restart");
});

test("a report's age reads in minutes, then hours", async () => {
  const describeAge = (updatedAt: string, at: number) => panel.describeAge(t, updatedAt, at);
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(describeAge("2026-10-07T11:59:40Z", now), "just now");
  assert.equal(describeAge("2026-10-07T11:53:00Z", now), "7 min ago");
  assert.equal(describeAge("2026-10-07T09:00:00Z", now), "3 h ago");
});

test("notices read as short chips with a tone (AC-GP3-01)", async () => {
  const describeNotice = (notice: Parameters<typeof panel.describeNotice>[1]) => panel.describeNotice(t, notice);
  assert.deepEqual(describeNotice({ kind: "stage_complete", stageId: "generate", title: "Generate" }), { text: "Generate: complete", tone: "ok" });
  assert.equal(describeNotice({ kind: "budget_100" }).tone, "bad");
  // BL-153 (a changed contract): the notice carries passed/rejected; the plain wording stays while nothing rejected waits.
  assert.equal(describeNotice({ kind: "review_waiting", count: 3, passed: 3, rejected: 0 }).text, "3 waiting for your verdict");
  assert.equal(describeNotice({ kind: "review_waiting", count: 12, passed: 5, rejected: 7 }).text, "12 waiting for your verdict (5 passed, 7 rejected by the validator)");
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-MV-07): a plan move has its own words in every interface language, with the channels'
// names (an unknown channel shows its id).
test("AC-MV-07: plan_moved names both channels by name when known, by id otherwise", () => {
  const names: Record<string, string> = { UC_tropico: "Tropico Jazz", UC_japan: "Rural Japan Music" };
  const event = { at: "", kind: "plan_moved", actor: "factory", details: { from: "UC_tropico", to: "UC_japan", checked: 34 } };
  assert.equal(panel.describeEvent(t, event, (id) => names[id] ?? id), "moved from Tropico Jazz to Rural Japan Music");
  assert.equal(panel.describeEvent(createTranslator("ru"), event, (id) => names[id] ?? id), "перенесён из Tropico Jazz в Rural Japan Music");
  assert.equal(panel.describeEvent(t, { ...event, details: { from: "UC_gone", to: "UC_japan", checked: 0 } }, (id) => names[id] ?? id), "moved from UC_gone to Rural Japan Music");
});
