import assert from "node:assert/strict";
import test from "node:test";
import { buildPatch, toFormValues, type VideoDetailsSnapshot } from "./video-details-panel";

// Independent review, round 3, 2026-09-26: found a real regression (recordingDate displayed one
// day earlier than stored, for any negative-UTC-offset viewer) that NO test in this codebase would
// have caught -- `shared-formatting`'s own tests only exercise that module's functions in
// isolation, never this component's actual wiring of which function (`formatDisplayDate` vs.
// `formatDisplayDateUtc`) goes with which field. These tests close that gap by exercising the real
// `toFormValues`/`buildPatch` functions this component actually calls, not a reimplementation of
// them, pinning a negative-UTC-offset timezone so the result never depends on which machine runs
// the suite.

function baseSnapshot(overrides: Partial<VideoDetailsSnapshot> = {}): VideoDetailsSnapshot {
  return {
    videoId: "v1",
    etag: "etag-1",
    title: "Title",
    description: "Description",
    tags: [],
    categoryId: null,
    defaultLanguage: null,
    privacyStatus: "private",
    publishAt: null,
    license: null,
    embeddable: null,
    publicStatsViewable: null,
    selfDeclaredMadeForKids: null,
    containsSyntheticMedia: null,
    recordingDate: null,
    ...overrides,
  };
}

function withTimezone<T>(tz: string, fn: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("toFormValues displays recordingDate as the same calendar day it was stored on, under a negative-UTC-offset timezone", () => {
  withTimezone("America/New_York", () => {
    // A pure calendar date is always stored at UTC midnight (parseDisplayDate's own write
    // direction) -- reading it back with LOCAL getters would roll it back to Jan 4th for this
    // exact timezone, the live-found bug this test guards against.
    const snapshot = baseSnapshot({ recordingDate: "2026-01-05T00:00:00.000Z" });
    const form = toFormValues(snapshot);
    assert.equal(form.recordingDate, "05.01.2026");
  });
});

test("toFormValues displays publishAt using the viewer's own local time, under a negative-UTC-offset timezone", () => {
  withTimezone("America/New_York", () => {
    // A genuine timestamp (has a real time-of-day) is correctly shown in the viewer's own local
    // time -- 2026-01-05T19:30:00.000Z is 14:30 in America/New_York (UTC-5 in January).
    const snapshot = baseSnapshot({ publishAt: "2026-01-05T19:30:00.000Z" });
    const form = toFormValues(snapshot);
    assert.equal(form.publishAt, "05.01.2026 14:30");
  });
});

test("buildPatch round-trips an unedited recordingDate back to a no-op, under a negative-UTC-offset timezone", () => {
  withTimezone("America/New_York", () => {
    const snapshot = baseSnapshot({ recordingDate: "2026-01-05T00:00:00.000Z" });
    const form = toFormValues(snapshot);
    // The operator never touched the field -- loading it and immediately diffing it back against
    // the same snapshot must never manufacture a spurious "changed" patch entry. This is exactly
    // what would break if `toFormValues` and `buildPatch`'s own `originalRecordingDateDisplay`
    // used two DIFFERENT format functions (one UTC, one local) instead of matching ones.
    const patch = buildPatch(form, snapshot);
    assert.equal(patch.recordingDate, undefined, "an untouched field must not appear in the patch");
  });
});

test("buildPatch converts an edited recordingDate back to the correct UTC wire value, under a negative-UTC-offset timezone", () => {
  withTimezone("America/New_York", () => {
    const snapshot = baseSnapshot({ recordingDate: "2026-01-05T00:00:00.000Z" });
    const form = toFormValues(snapshot);
    const edited = { ...form, recordingDate: "20.03.2026" };
    const patch = buildPatch(edited, snapshot);
    assert.equal(patch.recordingDate, "2026-03-20T00:00:00.000Z");
  });
});

test("buildPatch converts an edited publishAt back to the correct UTC wire value and forces privacyStatus private, under a negative-UTC-offset timezone", () => {
  withTimezone("America/New_York", () => {
    const snapshot = baseSnapshot({ privacyStatus: "private", publishAt: null });
    const form = toFormValues(snapshot);
    const edited = { ...form, publishAt: "20.03.2026 14:30" }; // interpreted as local (America/New_York, UTC-4 in March after DST)
    const patch = buildPatch(edited, snapshot);
    assert.equal(patch.publishAt, "2026-03-20T18:30:00.000Z");
    assert.equal(patch.privacyStatus, "private");
  });
});

// BL-182 review S1 (G1, 2026-10-13: YouTube sets "AI use" -- status.containsSyntheticMedia -- but returns null on read; videos.update
// replaces the whole status part it is sent). So with the value unreadable, a status write must send it explicitly, as the form
// shows it; an unreadable value starts checked (the owner sets it on every upload); a snippet-only write leaves the status part alone.
test("BL-182: rescheduling a video whose AI-use mark is unreadable sends it explicitly (checked by default) with private + the new date", () => {
  withTimezone("UTC", () => {
    const snapshot = baseSnapshot({ privacyStatus: "private", publishAt: "2099-10-14T12:00:00Z", containsSyntheticMedia: null });
    const form = { ...toFormValues(snapshot), publishAt: "16.10.2099 12:00" };
    assert.equal(form.containsSyntheticMedia, true);
    assert.deepEqual(buildPatch(form, snapshot), { privacyStatus: "private", publishAt: "2099-10-16T12:00:00.000Z", containsSyntheticMedia: true });
  });
});

test("BL-182: a snippet-only edit with the mark unreadable does not touch it; unchecking it sends false", () => {
  const snapshot = baseSnapshot({ containsSyntheticMedia: null });
  assert.deepEqual(buildPatch({ ...toFormValues(snapshot), title: "New" }, snapshot), { title: "New" });
  assert.deepEqual(buildPatch({ ...toFormValues(snapshot), containsSyntheticMedia: false }, snapshot), { containsSyntheticMedia: false });
});
