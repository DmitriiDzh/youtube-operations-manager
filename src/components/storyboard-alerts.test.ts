import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import { activeStoryboardsWaiting, mediaBadgeTitle, otherChannelStoryboardEntries } from "./storyboard-alerts";

// BL-184 stage 1 (FO-REQ-0024 §4 D: "storyboard waiting for review" -- a badge like Media's, the bell for the other channels; the
// BL-157 rule: the active channel has its badge, the others are in the bell).

const t = createTranslator("en");
const alerts = [
  { channelId: "UC_active", waiting: 2, storyboardId: null },
  { channelId: "UC_one", waiting: 1, storyboardId: "bar loop" },
  { channelId: "UC_two", waiting: 3, storyboardId: null },
];

test("the active channel's waiting storyboards go on the Media badge, never in the bell", () => {
  assert.equal(activeStoryboardsWaiting(alerts, "UC_active"), 2);
  assert.equal(activeStoryboardsWaiting(alerts, "UC_none"), 0);
  assert.deepEqual(
    otherChannelStoryboardEntries(t, alerts, "UC_active").map((e) => [e.channelId, e.text, e.href]),
    [
      ["UC_one", "1 storyboard waits for your review", "/media/storyboards/bar%20loop"],
      ["UC_two", "3 storyboards wait for your review", "/media/storyboards"],
    ]
  );
});

test("the Media badge's hover text names the storyboards next to the plans; unchanged when none wait", () => {
  assert.equal(mediaBadgeTitle(t, 4, 0, 0), undefined);
  assert.equal(mediaBadgeTitle(t, 4, 1, 0), t("plans.badgeSplit", { passed: 3, rejected: 1 }));
  assert.equal(mediaBadgeTitle(t, 4, 0, 2), "4 results wait for your verdict · 2 storyboards wait for your review");
  assert.equal(mediaBadgeTitle(t, 0, 0, 1), "1 storyboard waits for your review");
});
