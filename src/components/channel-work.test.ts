import assert from "node:assert/strict";
import test from "node:test";
import type { PlanChannelWork } from "@/lib/generation-plans/contracts";
import { createTranslator } from "@/lib/ui-text";
import { otherChannelEntries, planReviewHref, waitingLabel } from "./channel-work";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-03/04/05/06, owner msg 2119): the other channels' work in the switcher and the bell.
// Expected texts are written from the plan's examples (FO-REQ-0009 §3/§3a, SERVERS_MEDIA_PLAN.md AC-BL-03/04), not from running
// the code. With no rejected track the split is left out, as the BL-153 badge and notice already do (recorded in the plan).
// BL-152: the words are translated; the requirement checked here is the English wording (plus one Russian check).
// Changed 2026-11-16 (BL-262, owner msgs 4541/4542/4545 -- a requirement change, AGENTS.md §L): a bell row shows a short text
// (2-4 words) with a group icon and an urgency; the earlier full text moved unchanged into `detail` (the hover text).
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
  notices: [{ planId: "T-1", planTitle: "Jazz wave 1", device: null, notice: { kind: "attempts_exhausted", count: 2 } }],
});

test("AC-BL-04/06: only channels that are not active get entries; one review entry per channel with its split and each wave; one per plan notice", () => {
  const entries = otherChannelEntries(t, [japan, tropico], "UC_tropico");
  assert.deepEqual(entries, [
    {
      key: "UC_japan:review",
      channelId: "UC_japan",
      text: "169 tracks wait · C13 47 · C14 38",
      detail: "Media: 169 tracks waiting for review (20 passed, 149 rejected) · C13 47 · C14 38",
      group: "media",
      severity: "info",
      href: "/media/plans/R-0001-S1-music/review?device=win&host=DESKTOP-B0UCB4I",
    },
  ]);
  const fromJapan = otherChannelEntries(t, [japan, tropico], "UC_japan");
  assert.deepEqual(fromJapan, [
    { key: "UC_tropico:review", channelId: "UC_tropico", text: "5 tracks wait", detail: "Media: 5 tracks waiting for review", group: "media", severity: "info", href: "/media/plans" },
    // BL-184 stage 3: a plan's notice opens that plan (Media's kind tabs could hide it under the first tab).
    {
      key: "UC_tropico:here:T-1:attempts_exhausted",
      channelId: "UC_tropico",
      text: "Jazz wave 1: attempts used up (2)",
      detail: "Media: plan Jazz wave 1, attempts used up for 2 items",
      group: "media",
      severity: "action",
      href: "/media/plans/T-1/review",
    },
  ]);
  assert.deepEqual(otherChannelEntries(t, [japan, tropico], null).map((e) => e.key), ["UC_japan:review", "UC_tropico:review", "UC_tropico:here:T-1:attempts_exhausted"], "no active channel: every channel");
  assert.deepEqual(otherChannelEntries(t, [work({ channelId: "UC_quiet" })], null), [], "nothing open, no entry");
});

test("AC-BL-04: every notice kind shown in the bell has its words; the plan title names the plan", () => {
  const notices = work({
    channelId: "UC_x",
    notices: [
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "attempts_exhausted", count: 2 } },
      { planId: "P", planTitle: "", device: null, notice: { kind: "budget_80" } },
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "budget_100" } },
    ],
  });
  assert.deepEqual(otherChannelEntries(t, [notices], null).map((e) => [e.text, e.detail, e.severity]), [
    ["Plan P: attempts used up (2)", "Media: plan Plan P, attempts used up for 2 items", "action"],
    ["P: budget at 80%", "Media: plan P has used 80% of its budget", "info"],
    ["Plan P: budget used up", "Media: plan Plan P has reached its budget", "action"],
  ]);
});

test("BL-262 (owner msgs 4541/4542): the Russian short texts", () => {
  const ru = createTranslator("ru");
  const notices = work({
    channelId: "UC_x",
    waitingReview: 47,
    waitingPassed: 40,
    waitingRejected: 7,
    batches: [
      { planId: "P", groupId: "C13", title: "C13", waiting: 47 },
      { planId: "P", groupId: null, title: "rest", waiting: 0 },
    ],
    notices: [
      { planId: "P", planTitle: "План P", device: null, notice: { kind: "attempts_exhausted", count: 3 } },
      { planId: "P", planTitle: "План P", device: null, notice: { kind: "budget_80" } },
      { planId: "P", planTitle: "План P", device: null, notice: { kind: "budget_100" } },
    ],
  });
  assert.deepEqual(otherChannelEntries(ru, [notices], null).map((e) => e.text), [
    "47 треков ждут · C13 47",
    "План P: попытки кончились (3)",
    "План P: бюджет 80%",
    "План P: бюджет исчерпан",
  ]);
  assert.equal(otherChannelEntries(ru, [work({ channelId: "UC_y", waitingReview: 1, waitingPassed: 1 })], null)[0].text, "1 трек ждёт");
  assert.equal(otherChannelEntries(ru, [work({ channelId: "UC_y", waitingReview: 3, waitingPassed: 3 })], null)[0].text, "3 трека ждут");
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

test("BL-162 AC-UX-09: a review address may open a wave, on this device's plan or another's", () => {
  assert.equal(planReviewHref("R-1", undefined, "C14"), "/media/plans/R-1/review?wave=C14");
  assert.equal(planReviewHref("R-1", { deviceId: "win", hostname: "PC" }, "C10A"), "/media/plans/R-1/review?device=win&host=PC&wave=C10A");
  assert.equal(planReviewHref("R-1", undefined, ""), "/media/plans/R-1/review", "an empty wave is no wave");
});

test("owner msg 4535: a completed stage or a completed plan is not a bell entry -- the bell holds what waits for the owner", () => {
  const done = work({
    channelId: "UC_x",
    notices: [
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } },
      { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "plan_complete" } },
      { planId: "Q", planTitle: "Plan Q", device: { deviceId: "win", hostname: null }, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } },
    ],
  });
  assert.deepEqual(otherChannelEntries(t, [done], null), []);
  const mixed = work({ ...done, notices: [...done.notices, { planId: "P", planTitle: "Plan P", device: null, notice: { kind: "budget_100" } }] });
  assert.deepEqual(otherChannelEntries(t, [mixed], null).map((e) => e.key), ["UC_x:here:P:budget_100"], "the other notices stay");
});
