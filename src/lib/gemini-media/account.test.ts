import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { accountWideSpend, geminiKeyFingerprint } from "./account";
import type { GeminiPeerSpendReport } from "./contracts";

// BL-193 (ADR 0039): which other computers' Gemini spend counts toward this computer's limits, with the expected sums worked out
// by hand from the rule (same fingerprint; today = written since this computer's local midnight; month = since the 1st; a report
// dated more than 5 minutes ahead is not counted; this computer's own report never is).

test("the fingerprint: same key → same value on every computer, another key → another value, 32 hex characters, the spec's HMAC", () => {
  const a = "AIzaSyKeyOne0123456789abcdefghijk";
  const b = "AIzaSyKeyTwo0123456789abcdefghijk";
  assert.equal(geminiKeyFingerprint(a), geminiKeyFingerprint(a));
  assert.notEqual(geminiKeyFingerprint(a), geminiKeyFingerprint(b));
  assert.match(geminiKeyFingerprint(a), /^[0-9a-f]{32}$/);
  assert.equal(geminiKeyFingerprint(a), createHmac("sha256", "ytm/gemini-key-fingerprint/v1").update(a).digest("hex").slice(0, 32));
});

const FP = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const now = new Date(2026, 9, 16, 15, 0, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0).toISOString();
const report = (deviceId: string, fields: Partial<GeminiPeerSpendReport>): GeminiPeerSpendReport => ({ deviceId, hostname: deviceId, keyFingerprint: FP, updatedAt: at(16, 14), spentTodayUsd: 0, spentMonthUsd: 0, ...fields });

test("sums the same-key computers: today only from reports written today, the month from this month's, never another key, the future or itself", () => {
  const result = accountWideSpend({
    peers: [
      report("a", { updatedAt: at(16, 14), spentTodayUsd: 1.5, spentMonthUsd: 7 }), // today 1.5, month 7, stale (1 h old)
      report("b", { updatedAt: at(15, 22), spentTodayUsd: 2, spentMonthUsd: 4 }), // yesterday: today 0, month 4
      report("c", { keyFingerprint: OTHER, spentTodayUsd: 10, spentMonthUsd: 10 }), // another key: nothing
      report("d", { updatedAt: new Date(2026, 8, 30, 23, 0, 0).toISOString(), spentTodayUsd: 3, spentMonthUsd: 30 }), // last month: nothing
      report("e", { updatedAt: at(16, 15, 10), spentTodayUsd: 9, spentMonthUsd: 9 }), // 10 min in the future: nothing
      report("f", { updatedAt: at(16, 14, 58), spentTodayUsd: 0.25, spentMonthUsd: 0.5 }), // fresh
      report("me", { spentTodayUsd: 100, spentMonthUsd: 100 }), // this computer's own: nothing
      report("g", { keyFingerprint: null, spentTodayUsd: 5, spentMonthUsd: 5 }), // no key there: nothing
    ],
    ownDeviceId: "me",
    ownFingerprint: FP,
    dayStart: new Date(2026, 9, 16),
    monthStart: new Date(2026, 9, 1),
    now,
  });
  assert.equal(result.otherTodayUsd, 1.75); // 1.5 + 0 + 0.25
  assert.equal(result.otherMonthUsd, 11.5); // 7 + 4 + 0.5
  assert.deepEqual(
    result.otherComputers.map((p) => [p.deviceId, p.todayUsd, p.monthUsd, p.stale]),
    [
      ["a", 1.5, 7, true],
      ["b", 0, 4, true],
      ["f", 0.25, 0.5, false],
    ]
  );
});

test("no fingerprint on this computer (no usable key): nothing is matched", () => {
  const result = accountWideSpend({ peers: [report("a", { spentTodayUsd: 1, spentMonthUsd: 1 })], ownDeviceId: "me", ownFingerprint: null, dayStart: new Date(2026, 9, 16), monthStart: new Date(2026, 9, 1), now });
  assert.deepEqual(result, { otherTodayUsd: 0, otherMonthUsd: 0, otherComputers: [] });
});

test("boundaries: exactly 5 minutes ahead still counts, a second more does not; a report written at local midnight counts toward today", () => {
  const result = accountWideSpend({
    peers: [
      report("a", { updatedAt: at(16, 15, 5), spentTodayUsd: 0.5, spentMonthUsd: 0.5 }), // exactly +5 min: counted
      report("b", { updatedAt: new Date(2026, 9, 16, 15, 5, 1).toISOString(), spentTodayUsd: 9, spentMonthUsd: 9 }), // +5 min 1 s: not
      report("c", { updatedAt: at(16, 0), spentTodayUsd: 0.75, spentMonthUsd: 2 }), // midnight sharp, 15 h old: today and month
      report("d", { updatedAt: new Date(2026, 9, 15, 23, 59, 59).toISOString(), spentTodayUsd: 4, spentMonthUsd: 6 }), // a second before: month only
    ],
    ownDeviceId: "me",
    ownFingerprint: FP,
    dayStart: new Date(2026, 9, 16),
    monthStart: new Date(2026, 9, 1),
    now,
  });
  assert.equal(result.otherTodayUsd, 1.25); // 0.5 + 0.75
  assert.equal(result.otherMonthUsd, 8.5); // 0.5 + 2 + 6
  assert.deepEqual(
    result.otherComputers.map((p) => [p.deviceId, p.stale]),
    [
      ["a", false],
      ["c", true],
      ["d", true],
    ]
  );
});

test("two computers on the same key are both summed; a computer with no key of its own (null) never matches, even another null", () => {
  const sameKey = accountWideSpend({
    peers: [report("a", { spentTodayUsd: 1.1, spentMonthUsd: 2.2 }), report("b", { spentTodayUsd: 0.4, spentMonthUsd: 0.8 })],
    ownDeviceId: "me",
    ownFingerprint: FP,
    dayStart: new Date(2026, 9, 16),
    monthStart: new Date(2026, 9, 1),
    now,
  });
  assert.equal(sameKey.otherTodayUsd, 1.5);
  assert.equal(sameKey.otherMonthUsd, 3);
  const bothNull = accountWideSpend({ peers: [report("a", { keyFingerprint: null, spentTodayUsd: 1, spentMonthUsd: 1 })], ownDeviceId: "me", ownFingerprint: null, dayStart: new Date(2026, 9, 16), monthStart: new Date(2026, 9, 1), now });
  assert.deepEqual(bothNull, { otherTodayUsd: 0, otherMonthUsd: 0, otherComputers: [] });
});
