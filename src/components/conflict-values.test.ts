import assert from "node:assert/strict";
import test from "node:test";
import { formatValue, listDiff, settingLabel, wordDiff } from "./conflict-values";

// Owner, Telegram 2026-10-07 (msg 2013): conflicts shown so deciding is as simple as possible -- named fields, values in words,
// and exactly what differs highlighted.

test("a setting reads in words: its name, its unit, On/Off, not set", () => {
  assert.equal(settingLabel("maxUsdPerDay"), "Daily spend cap");
  assert.equal(formatValue(25, "usd"), "$25");
  assert.equal(formatValue(0.69, "usd_per_hr"), "$0.69/h");
  assert.equal(formatValue(10, "minutes"), "10 min");
  assert.equal(formatValue(true), "On");
  assert.equal(formatValue(null), "not set");
  assert.equal(formatValue([]), "none");
});

test("two texts: only the words that differ are marked, on each side", () => {
  const { left, right } = wordDiff("Calm koto music for sleep", "Calm piano music for deep sleep");
  assert.deepEqual(left.filter((t) => t.changed).map((t) => t.text.trim()), ["koto"]);
  assert.deepEqual(right.filter((t) => t.changed).map((t) => t.text.trim()), ["piano", "deep"]);
  assert.equal(left.map((t) => t.text).join(""), "Calm koto music for sleep");
});

test("two ordered lists: an item differs where the other list has another item in that place", () => {
  const { left, right } = listDiff(["NVIDIA L4", "NVIDIA A40", "RTX A5000"], ["NVIDIA L4", "RTX A5000"]);
  assert.deepEqual(left.map((t) => t.changed), [false, true, true]);
  assert.deepEqual(right.map((t) => t.changed), [false, true]);
});
