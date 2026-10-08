import assert from "node:assert/strict";
import test from "node:test";
import type { PlanChannelWork } from "@/lib/generation-plans/contracts";
import { createTranslator } from "@/lib/ui-text";
import { otherChannelEntries, planReviewHref, waitingLabel } from "./channel-work";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-03/04/05/06, owner msg 2119): the other channels' work in the switcher and the bell.
// Expected texts are written from the plan's examples (FO-REQ-0009 §3/§3a, SERVERS_MEDIA_PLAN.md AC-BL-03/04), not from running
// the code. With no rejected track the split is left out, as the BL-153 badge and notice already do (recorded in the plan).
// BL-152: the words are translated; the requirement checked here is the English wording (plus one Russian check).
const t = createTranslator("en");

const work = (over: Partial<PlanChannelWork> & { channelId: string }): PlanChannelWork => ({ waitingReview: 0, waitingPassed: 0, waitingRejected: 0, plans: [], batches: [], notices: [], ...over });

const japan = work({
  channelId: "UC_japan",
  waitingReview: 169,
  waitingPassed: 20,
  waitingRejected: 149,
  plans: [{ planId: "R-0001-S1-music", title: "R-0001 music", device: { deviceId: "win", hostname: "DESKTOP-B0UCB4I" }, waiting: 169 }],
  batches: [
    { planId: "R-0001-S1-music", groupId: "C13", title: "C13", waiting: 47 },
    { planId: "R-0001-S1-music", groupId: "C14", title: "C14", waiting: 38 },
  ],
});
const tropico = work({
  channelId: "UC_tropico",
  waitingReview: 5,
  waitingPassed: 5,
  plans: [
    { planId: "T-1", title: "T-1", device: null, waiting: 3 },
    { planId: "T-2", title: "T-2", device: null, waiting: 2 },
  ],
  notices: [{ planId: "T-1", planTitle: "Jazz wave 1", device: null, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } }],
});

test("AC-BL-04/06: only channels that are not active get entries; one review entry per channel with its split and each wave; one per plan notice", () => {
  const entries = otherChannelEntries(t, [japan, tropico], "UC_tropico");
  assert.deepEqual(entries, [
    {
      key: "UC_japan:review",
      channelId: "UC_japan",
      text: "Media: 169 tracks waiting for review (20 passed, 149 rejected) · C13 47 · C14 38",
      href: "/media/plans/R-0001-S1-music/review?device=win&host=DESKTOP-B0UCB4I",
    },
  ]);
  const fromJapan = otherChannelEntries(t, [japan, tropico], "UC_japan");
  assert.deepEqual(fromJapan, [
    { key: "UC_tropico:review", channelId: "UC_tropico", text: "Media: 5 tracks waiting for review", href: "/media/plans" },
    { key: "UC_tropico:here:T-1:stage_complete", channelId: "UC_tropico", text: "Media: plan Jazz wave 1, stage complete: Generate", href: "/media/plans" },
  ]);
  assert.deepEqual(otherChannelEntries(t, [japan, tropico], null).map((e) => e.key), ["UC_japan:review", "UC_tropico:review", "UC_tropico:here:T-1:stage_complete"], "no active channel: every channel");
  assert.deepEqual(otherChannelEntries(t, [work({ channelId: "UC_quiet" })], null), [], "nothing open, no entry");
});

test("AC-BL-04: every notice kind has its words; the plan title names the plan", () => {
  const notices = work({
    channelId: "UC_x",
    notices: [
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "plan_complete" } },
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "attempts_exhausted", count: 2 } },
      { planId: "P", planTitle: "", device: null, notice: { kind: "budget_80" } },
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "budget_100" } },
    ],
  });
  assert.deepEqual(otherChannelEntries(t, [notices], null).map((e) => e.text), [
    "Media: plan Plan P complete",
    "Media: plan Plan P, attempts used up for 2 items",
    "Media: plan P has used 80% of its budget",
    "Media: plan Plan P has reached its budget",
  ]);
});

test("AC-BL-03: the switcher line -- '5 waiting (3 passed, 2 rejected)', '4 waiting', nothing when nothing waits", () => {
  assert.equal(waitingLabel(t, { waitingReview: 5, waitingPassed: 3, waitingRejected: 2 }), "5 waiting (3 passed, 2 rejected)");
  assert.equal(waitingLabel(t, { waitingReview: 4, waitingPassed: 4, waitingRejected: 0 }), "4 waiting");
  assert.equal(waitingLabel(t, { waitingReview: 0, waitingPassed: 0, waitingRejected: 0 }), null);
  assert.equal(waitingLabel(t, undefined), null);
  assert.equal(waitingLabel(createTranslator("ru"), { waitingReview: 5, waitingPassed: 3, waitingRejected: 2 }), "ждут: 5 (прошли: 3, отбракованы: 2)");
});

test("AC-BL-05: a review address names another device's plan by its device and host", () => {
  assert.equal(planReviewHref("R-1"), "/media/plans/R-1/review");
  assert.equal(planReviewHref("R 1", { deviceId: "win", hostname: null }), "/media/plans/R%201/review?device=win");
});

test("AC-BL-04 (review round 1): one entry per plan and notice kind -- a plan's completed stages are one entry naming them all", () => {
  const work2 = work({
    channelId: "UC_x",
    notices: [
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } },
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "stage_complete", stageId: "validate", title: "Validator" } },
      { planId: "Q", planTitle: "Plan Q", device: { deviceId: "win", hostname: null }, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } },
    ],
  });
  assert.deepEqual(otherChannelEntries(t, [work2], null).map((e) => [e.key, e.text]), [
    ["UC_x:here:P:stage_complete", "Media: plan Plan P, stage complete: Generate, Validator"],
    ["UC_x:win:Q:stage_complete", "Media: plan Plan Q, stage complete: Generate"],
  ]);
});
