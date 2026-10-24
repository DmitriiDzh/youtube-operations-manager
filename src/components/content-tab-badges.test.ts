import assert from "node:assert/strict";
import test from "node:test";
import { contentTabBadges } from "./content-tab-badges";

// BL-221 (CONTENT_UX_PLAN.md stage E): each badge from the plan's rule; a failed read gives no badge.

test("BL-221: «Ролики и релизы» counts the numbers whose video or package is ready and not on YouTube yet", () => {
  const badges = contentTabBadges({
    projects: {
      videos: [
        { state: "in_work", hasVideoFile: true }, // video ready
        { state: "packaged", hasVideoFile: true }, // package ready
        { state: "in_work", hasVideoFile: false }, // preparation: not counted
        { state: "packaged", youtubeVideoId: "abcdefghijk" }, // on YouTube: not counted
        { state: "published" }, // published: not counted
        { state: "cancelled", hasVideoFile: true }, // cancelled: not counted
      ],
    },
    calendar: null,
    live: null,
  });
  assert.deepEqual(badges, { releases: 2, calendarDue: false, streamTrouble: false });
});

test("BL-221: the calendar badge needs a synced channel that is due; the stream badge needs a live broadcast in trouble", () => {
  const live = (lifeCycleStatus: string, healthStatus: string | null, intent = "on") => ({ stream: { intent }, youtube: { lifeCycleStatus, healthStatus } });
  assert.equal(contentTabBadges({ projects: null, calendar: { lastSyncedAt: "2026-10-24T10:00:00Z", coverage: { due: true } }, live: null }).calendarDue, true);
  assert.equal(contentTabBadges({ projects: null, calendar: { lastSyncedAt: null, coverage: { due: true } }, live: null }).calendarDue, false);
  assert.equal(contentTabBadges({ projects: null, calendar: null, live: live("live", "bad") }).streamTrouble, true);
  assert.equal(contentTabBadges({ projects: null, calendar: null, live: live("live", "noData") }).streamTrouble, true);
  assert.equal(contentTabBadges({ projects: null, calendar: null, live: live("live", "good") }).streamTrouble, false);
  assert.equal(contentTabBadges({ projects: null, calendar: null, live: live("complete", "bad") }).streamTrouble, false);
  assert.equal(contentTabBadges({ projects: null, calendar: null, live: live("live", "bad", "off") }).streamTrouble, false);
});
