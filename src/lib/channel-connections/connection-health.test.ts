import assert from "node:assert/strict";
import test from "node:test";
import { classifyConnectionHealth } from "./connection-health";

const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * 86_400_000 - extraMs);
const MIN = 60_000;

// Expected values are derived from the requirement (Google: Testing-status refresh token dies 7 days after
// issue; warn from 6 days), not from reading the implementation.

test("no usable real check: 5d23h59m is ok, 6d is expiring_soon, 6d23h59m is expiring_soon, exactly 7d is reauth_required", () => {
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(6, -MIN), probe: "not_run", now: NOW }).state, "ok"); // 6d minus 1 min = 5d23h59m
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(6), probe: "not_run", now: NOW }).state, "expiring_soon");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(7, -MIN), probe: "not_run", now: NOW }).state, "expiring_soon"); // 7d minus 1 min = 6d23h59m
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(7), probe: "not_run", now: NOW }).state, "reauth_required");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(30), probe: "error", now: NOW }).state, "reauth_required");
});

test("invalid_grant is final: reauth_required for a brand-new grant and for an unknown age", () => {
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(0), probe: "invalid_grant", now: NOW }).state, "reauth_required");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: null, probe: "invalid_grant", now: NOW }).state, "reauth_required");
});

test("a passing real check: young is ok, 6d..7d is expiring_soon, 7d+ is ok (the 7-day limit is evidently not in force), unknown age is ok", () => {
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(2), probe: "ok", now: NOW }).state, "ok");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(6.5), probe: "ok", now: NOW }).state, "expiring_soon");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: ago(9), probe: "ok", now: NOW }).state, "ok");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: null, probe: "ok", now: NOW }).state, "ok");
});

test("unknown age with no usable real check is unknown (never a popup), and a failed check does not turn it into reauth_required", () => {
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: null, probe: "not_run", now: NOW }).state, "unknown");
  assert.equal(classifyConnectionHealth({ refreshTokenIssuedAt: null, probe: "error", now: NOW }).state, "unknown");
});

test("ageDays is whole days; daysLeft counts down to the 7-day limit and is never negative", () => {
  assert.deepEqual(classifyConnectionHealth({ refreshTokenIssuedAt: ago(6.5), probe: "not_run", now: NOW }), { state: "expiring_soon", ageDays: 6, daysLeft: 1 });
  assert.deepEqual(classifyConnectionHealth({ refreshTokenIssuedAt: ago(2), probe: "ok", now: NOW }), { state: "ok", ageDays: 2, daysLeft: 5 });
  assert.deepEqual(classifyConnectionHealth({ refreshTokenIssuedAt: ago(10), probe: "not_run", now: NOW }), { state: "reauth_required", ageDays: 10, daysLeft: 0 });
});

test("an issue date in the future (clock skew) is age 0, not a negative age", () => {
  const result = classifyConnectionHealth({ refreshTokenIssuedAt: new Date(NOW.getTime() + 3_600_000), probe: "not_run", now: NOW });
  assert.equal(result.state, "ok");
  assert.equal(result.ageDays, 0);
});
