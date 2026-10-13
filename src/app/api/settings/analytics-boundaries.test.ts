import assert from "node:assert/strict";
import test from "node:test";
import { checkAnalyticsBoundaries } from "./analytics-boundaries";

// BL-181 (FO-REQ-0020 §2.3; plan REPORTING_BASIC_PLAN.md §2 item 7): the evening boundary is "HH:MM" or "" (off), and later than the
// daily boundary; a save that would leave the pair the wrong way round is refused, whichever of the two it moves.

const stored = { currentEvening: "22:05", currentMorning: "12:05" };

test("a save without either time changes nothing", () => {
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: undefined, morningToSet: undefined }), { ok: true });
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: null, morningToSet: undefined }), { ok: true });
});

test("a new evening time later than the daily boundary is saved; '' turns it off", () => {
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: "21:30", morningToSet: undefined }), { ok: true, eveningToSet: "21:30" });
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: "", morningToSet: undefined }), { ok: true, eveningToSet: "" });
});

test("an evening time not later than the daily boundary is refused, also against a daily boundary set in the same save", () => {
  assert.equal(checkAnalyticsBoundaries({ ...stored, eveningInput: "12:05", morningToSet: undefined }).ok, false);
  assert.equal(checkAnalyticsBoundaries({ ...stored, eveningInput: "09:00", morningToSet: undefined }).ok, false);
  assert.equal(checkAnalyticsBoundaries({ ...stored, eveningInput: "18:00", morningToSet: "19:00" }).ok, false);
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: "23:00", morningToSet: "19:00" }), { ok: true, eveningToSet: "23:00" });
});

test("moving only the daily boundary past the stored evening time is refused; with the evening off it is fine", () => {
  assert.equal(checkAnalyticsBoundaries({ ...stored, eveningInput: undefined, morningToSet: "22:30" }).ok, false);
  assert.deepEqual(checkAnalyticsBoundaries({ ...stored, eveningInput: undefined, morningToSet: "13:00" }), { ok: true });
  assert.deepEqual(checkAnalyticsBoundaries({ currentEvening: "", currentMorning: "12:05", eveningInput: undefined, morningToSet: "23:00" }), { ok: true });
});

test("a malformed evening value is refused", () => {
  for (const bad of ["22.05", "25:00", "2205", 2205, true, "22:5"]) {
    assert.equal(checkAnalyticsBoundaries({ ...stored, eveningInput: bad, morningToSet: undefined }).ok, false, String(bad));
  }
});
