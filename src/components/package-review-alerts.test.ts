import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import { activePackagesWaiting, otherChannelPackageEntries } from "./package-review-alerts";
import { mediaBadgeTitle } from "./storyboard-alerts";

// BL-257 fix (owner report 2026-11-24: WWE V31/V32 waited for review, nothing showed). The requirement: final videos waiting for the
// owner count like every other review -- on the Media menu badge for the active channel, a bell entry leading to Media → «Видео на
// проверку» for each other channel (the BL-157 rule, AC-BL-04/06: the active channel has its badge, the others are in the bell); a
// channel with nothing waiting shows nothing (after the owner's approval or return the summary no longer lists it).

const t = createTranslator("en");

test("one waiting video on the active channel: Media badge 1, no bell entry for it", () => {
  const alerts = [{ channelId: "UC_wwe", waiting: 1 }];
  assert.equal(activePackagesWaiting(alerts, "UC_wwe"), 1);
  assert.deepEqual(otherChannelPackageEntries(t, alerts, "UC_wwe"), []);
});

test("another channel's waiting videos: one bell entry that opens its Media → «Videos for review»", () => {
  const alerts = [
    { channelId: "UC_active", waiting: 3 },
    { channelId: "UC_wwe", waiting: 2 },
  ];
  assert.equal(activePackagesWaiting(alerts, "UC_active"), 3);
  assert.deepEqual(otherChannelPackageEntries(t, alerts, "UC_active"), [
    {
      key: "UC_wwe:packages:waiting",
      channelId: "UC_wwe",
      text: "2 videos to review",
      detail: "Media → «Videos for review»: 2 videos wait for your review",
      group: "packages",
      severity: "info",
      href: "/media/packages",
    },
  ]);
  const ru = createTranslator("ru");
  assert.deepEqual(
    otherChannelPackageEntries(ru, [{ channelId: "UC_a", waiting: 1 }, { channelId: "UC_b", waiting: 3 }], null).map((e) => e.text),
    ["1 видео ждёт проверки", "3 видео ждут проверки"]
  );
});

test("nothing waiting (after an approval or a return): badge 0 and no bell entry", () => {
  assert.equal(activePackagesWaiting([], "UC_wwe"), 0);
  assert.deepEqual(otherChannelPackageEntries(t, [], "UC_active"), []);
  assert.deepEqual(otherChannelPackageEntries(t, [{ channelId: "UC_wwe", waiting: 0 }], "UC_active"), []);
});

test("the Media badge's hover text names the waiting videos; unchanged when none wait", () => {
  assert.equal(mediaBadgeTitle(t, 4, 0, 0, 0), undefined);
  assert.equal(mediaBadgeTitle(t, 0, 0, 0, 1), "Media → «Videos for review»: 1 video waits for your review");
  assert.equal(mediaBadgeTitle(t, 4, 0, 2, 1), "4 results wait for your verdict · 2 storyboards wait for your review · Media → «Videos for review»: 1 video waits for your review");
});
