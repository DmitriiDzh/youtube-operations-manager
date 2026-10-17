import assert from "node:assert/strict";
import test from "node:test";
import { BUSY_HOLD_MAX_MS, BUSY_MIN_VISIBLE_MS, BUSY_SHOW_DELAY_MS, NOTICE_OK_MS, ACTION_DONE_FLASH_MS, busyVisibleAt, busyWindow } from "./busy-state";

// BL-195 (docs/roadmap/plans/UI_FEEDBACK_CLARITY_PLAN.md §2 and §4): the expected times come from the plan's rules -- no window for
// an action under 300 ms, shown from 300 ms, then at least 500 ms -- worked out by hand, never by running the code.

test("the plan's numbers: 300 ms delay, 500 ms minimum, 20 s hold cap, ✓ for 2 s, a success message for 4 s", () => {
  assert.deepEqual([BUSY_SHOW_DELAY_MS, BUSY_MIN_VISIBLE_MS, BUSY_HOLD_MAX_MS, ACTION_DONE_FLASH_MS, NOTICE_OK_MS], [300, 500, 20_000, 2_000, 4_000]);
});

test("AC-FB-01: under 300 ms no window; 1 s shows it 300 ms -> 1 s; 350 ms shows it 300 -> 800 ms", () => {
  assert.equal(busyWindow(1_000, 1_250), null);
  assert.equal(busyWindow(1_000, 1_299), null);
  assert.deepEqual(busyWindow(1_000, 2_000), { showAt: 1_300, hideAt: 2_000 });
  assert.deepEqual(busyWindow(1_000, 1_350), { showAt: 1_300, hideAt: 1_800 });
  // Ending exactly when it would show: it shows, for the minimum.
  assert.deepEqual(busyWindow(1_000, 1_300), { showAt: 1_300, hideAt: 1_800 });
});

test("AC-FB-01: a running action shows from 300 ms with no end yet", () => {
  assert.deepEqual(busyWindow(0, null), { showAt: 300, hideAt: null });
  assert.equal(busyVisibleAt(0, null, 299), false);
  assert.equal(busyVisibleAt(0, null, 300), true);
  assert.equal(busyVisibleAt(0, null, 60_000), true);
});

test("AC-FB-01: visibility at the edges of a 350 ms action and of a 200 ms one", () => {
  assert.equal(busyVisibleAt(0, 350, 299), false);
  assert.equal(busyVisibleAt(0, 350, 300), true);
  assert.equal(busyVisibleAt(0, 350, 799), true);
  assert.equal(busyVisibleAt(0, 350, 800), false);
  for (const now of [0, 150, 300, 600]) assert.equal(busyVisibleAt(0, 200, now), false);
});
