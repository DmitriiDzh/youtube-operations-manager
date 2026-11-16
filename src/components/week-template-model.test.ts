import assert from "node:assert/strict";
import test from "node:test";
import { freePositions, isMusicTemplateDto, localAndUtc, parseTemplateTime, templateDiff, type TemplateDto } from "./week-template-model";

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.9, AC-WT-30/43/49; owner O6, O7). Values by hand: 2026-11-23 15:00Z is 18:00 in Moscow (UTC+3, no
// summer time) the same day and 00:00 in Tokyo (UTC+9) the next day; 2026-11-23 is a Monday.

const WWE: TemplateDto = {
  format: "week-template/1",
  channelId: "UC",
  horizonWeeks: 2,
  displayTimeZone: null,
  days: { mon: [{ kind: "long", publishTimeUtc: "15:00" }, { kind: "short", publishTimeUtc: "12:00" }], tue: [{ kind: "short", publishTimeUtc: "12:00" }] },
};

test("AC-WT-43 (O6): an instant reads as the owner's own time with UTC beside it, and the day shift is visible", () => {
  assert.deepEqual(localAndUtc("2026-11-23T15:00:00.000Z", "Europe/Moscow"), { local: "18:00", utc: "15:00", dayShift: 0, localYmd: "2026-11-23" });
  assert.deepEqual(localAndUtc("2026-11-23T15:00:00.000Z", "Asia/Tokyo"), { local: "00:00", utc: "15:00", dayShift: 1, localYmd: "2026-11-24" });
});

test("AC-WT-30: the week's free template positions are those no live slot holds, from now on", () => {
  const slots = [{ vetoed: null, dating: { position: { date: "2026-11-23", index: 0 } } }, { vetoed: { at: "x" }, dating: { position: { date: "2026-11-24", index: 0 } } }];
  const free = freePositions(WWE.days, "2026-11-23", slots, Date.parse("2026-11-20T00:00:00Z"));
  // Monday: short 12:00 (index 0) held, long 15:00 (index 1) free; Tuesday's short held only by a vetoed slot -> free.
  assert.deepEqual(free.map((p) => [p.date, p.entry.kind, p.entry.publishTimeUtc]), [["2026-11-23", "long", "15:00"], ["2026-11-24", "short", "12:00"]]);
  assert.deepEqual(freePositions(WWE.days, "2026-11-23", slots, Date.parse("2026-11-24T13:00:00Z")), [], "past positions are not offered");
});

test("the template time is HH:MM with minutes in steps of 5; the diff lists only changed days", () => {
  assert.equal(parseTemplateTime("9:05"), "09:05");
  assert.equal(parseTemplateTime("15:03"), null);
  assert.equal(parseTemplateTime("24:00"), null);
  const after: TemplateDto = { ...WWE, days: { ...WWE.days, tue: [] } };
  assert.deepEqual(templateDiff(WWE, after), [{ day: "tue", before: ["short 12:00"], after: [] }]);
});

test("AC-WT-49 (O7): a music template is every entry long with hours", () => {
  assert.equal(isMusicTemplateDto({ ...WWE, days: { mon: [{ kind: "long", hours: 3, publishTimeUtc: "12:00" }], fri: [{ kind: "long", hours: 8, publishTimeUtc: "12:00" }] } }), true);
  assert.equal(isMusicTemplateDto(WWE), false);
  assert.equal(isMusicTemplateDto(null), false);
});
