import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import { contentBadge, otherChannelPublishingEntries, type PublishingAlertChannel } from "./publishing-alerts";

// BL-182 stage 1 (FO-REQ-0023 §4 D2-D5): the reminder is a badge on «Контент» for the active channel and a bell entry for each other
// channel (the BL-157 rule), with the coverage date and the data age in its text; it shows only while coverage ends within the
// threshold, and goes away by itself once enough is scheduled.

const t = createTranslator("ru");
const alert = (over: Partial<PublishingAlertChannel>): PublishingAlertChannel => ({
  channelId: "UC_A",
  lastSyncedAt: "2026-10-13T11:00:00.000Z",
  coveredThrough: "2026-10-14T12:00:00Z",
  scheduledCount: 1,
  unscheduledCount: 0,
  daysCovered: 1,
  due: true,
  thresholdDays: 7,
  ...over,
});

test("badge: the days missing to a week of coverage (at least 1), the coverage on hover; nothing when covered", () => {
  const badge = contentBadge(t, alert({}));
  assert.equal(badge.badge, 6, "7 - 1 day covered");
  assert.match(badge.badgeTitle ?? "", /14\.10\.2026/);
  assert.equal(contentBadge(t, alert({ coveredThrough: null, daysCovered: 0 })).badge, 7);
  assert.equal(contentBadge(t, alert({ daysCovered: 7, due: true })).badge, 1, "never 0 while due");
  assert.deepEqual(contentBadge(t, alert({ due: false, daysCovered: 9 })), { badge: 0 });
  assert.deepEqual(contentBadge(t, undefined), { badge: 0 });
});

test("bell: one entry per other channel that is due, linking to the calendar; the active one and covered ones are left out", () => {
  const entries = otherChannelPublishingEntries(
    t,
    [alert({ channelId: "UC_A" }), alert({ channelId: "UC_B", coveredThrough: null, daysCovered: 0 }), alert({ channelId: "UC_C", due: false })],
    "UC_A"
  );
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].key, entries[0].channelId, entries[0].href], ["UC_B:publishing:coverage", "UC_B", "/content/calendar"]);
  // Changed 2026-11-16 (BL-262, owner msgs 4541/4542 -- a requirement change, AGENTS.md §L): the row says only «Ничего не
  // запланировано»; the data age moved into the hover text (`detail`).
  assert.equal(entries[0].text, "Ничего не запланировано");
  assert.match(entries[0].detail, /Ничего не запланировано/);
  assert.match(entries[0].detail, /13\.10\.2026/, "the data age is in the hover text");
  assert.deepEqual([entries[0].group, entries[0].severity], ["publishing", "info"]);
});

test("BL-262 (owner msgs 4541/4542): a partly covered week -- «План только до {date}», the day count and data age on hover", () => {
  const [entry] = otherChannelPublishingEntries(t, [alert({ channelId: "UC_B" })], null);
  assert.equal(entry.text, "План только до 14.10.2026");
  assert.match(entry.detail, /14\.10\.2026/);
  assert.match(entry.detail, /1 день/);
  assert.match(entry.detail, /13\.10\.2026/);
  assert.equal(otherChannelPublishingEntries(createTranslator("en"), [alert({ channelId: "UC_B" })], null)[0].text, "Scheduled only through 14.10.2026");
});
