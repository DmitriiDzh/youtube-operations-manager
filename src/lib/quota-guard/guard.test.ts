import assert from "node:assert/strict";
import test from "node:test";
import { backgroundReadAllowed, evaluateWriteRun, remainingWriteUnits, videosThatFit } from "./guard";
import { QUOTA_SAFETY_MARGIN_UNITS, UNITS_PER_WRITTEN_VIDEO, type QuotaSnapshot } from "./contracts";

// Hand-computed from the requirement: a written video costs 1 (fresh list) + 50 (update) + 1 (read-back) = 52 units;
// 100 units are always held back; 2 minutes of this device's own calls are not yet in Google's figure.
const known = (limit: number, used: number, recentLocalUnits = 0): QuotaSnapshot => ({ known: true, limit, used, recentLocalUnits, resetsAt: "2026-10-04T07:00:00.000Z" });

test("the per-video cost is 52 and the margin 100 (the constants the rest of the guard rests on)", () => {
  assert.equal(UNITS_PER_WRITTEN_VIDEO, 52);
  assert.equal(QUOTA_SAFETY_MARGIN_UNITS, 100);
});

test("remaining = limit - used - recent local calls - 100, never negative", () => {
  assert.equal(remainingWriteUnits(known(10000, 4000, 300) as Extract<QuotaSnapshot, { known: true }>), 5600);
  assert.equal(remainingWriteUnits(known(10000, 9950) as Extract<QuotaSnapshot, { known: true }>), 0);
  assert.equal(remainingWriteUnits(known(10000, 12000) as Extract<QuotaSnapshot, { known: true }>), 0);
});

test("videosThatFit is floor(remaining / 52)", () => {
  assert.equal(videosThatFit(51), 0);
  assert.equal(videosThatFit(52), 1);
  assert.equal(videosThatFit(103), 1);
  assert.equal(videosThatFit(104), 2);
  assert.equal(videosThatFit(-5), 0);
});

test("boundary: an estimate EQUAL to what is left is allowed; one unit over is blocked", () => {
  // remaining = 10000 - 8000 - 0 - 100 = 1900; 36 videos = 1872 <= 1900; 37 videos = 1924 > 1900.
  const q = known(10000, 8000);
  assert.deepEqual(evaluateWriteRun(36, q), { decision: "allow", estimatedUnits: 1872, remainingUnits: 1900, fitVideos: 36 });
  const blocked = evaluateWriteRun(37, q);
  assert.equal(blocked.decision, "insufficient");
  if (blocked.decision === "insufficient") {
    assert.equal(blocked.estimatedUnits, 1924);
    assert.equal(blocked.remainingUnits, 1900);
    assert.equal(blocked.fitVideos, 36);
    assert.equal(blocked.resetsAt, "2026-10-04T07:00:00.000Z");
  }
  // exact equality of estimate and remaining: remaining = 1872 + 100 -> limit 10000, used 8028
  assert.equal(evaluateWriteRun(36, known(10000, 8028)).decision, "allow");
  assert.equal(evaluateWriteRun(36, known(10000, 8029)).decision, "insufficient");
});

test("the owner's example: 45 videos need 2340 units; with 2339 left it is blocked and 44 videos fit", () => {
  // remaining 2339 -> used = 10000 - 2339 - 100 = 7561
  const v = evaluateWriteRun(45, known(10000, 7561));
  assert.equal(v.decision, "insufficient");
  if (v.decision === "insufficient") {
    assert.equal(v.estimatedUnits, 2340);
    assert.equal(v.remainingUnits, 2339);
    assert.equal(v.fitVideos, 44);
  }
});

test("zero videos fit when less than 52 units are left", () => {
  const v = evaluateWriteRun(3, known(10000, 9849)); // remaining = 51
  assert.equal(v.decision, "insufficient");
  if (v.decision === "insufficient") assert.equal(v.fitVideos, 0);
});

test("unknown quota (Cloud not connected / lookup failed) is its own verdict, with the estimate, never allow or block by itself", () => {
  assert.deepEqual(evaluateWriteRun(10, { known: false, cloudConnected: false }), { decision: "unknown", estimatedUnits: 520, cloudConnected: false });
  assert.deepEqual(evaluateWriteRun(10, { known: false, cloudConnected: true }), { decision: "unknown", estimatedUnits: 520, cloudConnected: true });
});

test("recent local calls (not yet in Google's number) shrink what is left", () => {
  // 10000 - 8000 - 600 - 100 = 1300 -> 25 videos (1300) fit exactly, 26 do not
  assert.equal(evaluateWriteRun(25, known(10000, 8000, 600)).decision, "allow");
  assert.equal(evaluateWriteRun(26, known(10000, 8000, 600)).decision, "insufficient");
});

test("background reads: allowed while at least the reserve percent of the limit is left; exactly the reserve is allowed; unknown never blocks", () => {
  // limit 10000, reserve 20% = 2000 units must remain
  assert.equal(backgroundReadAllowed(known(10000, 8000), 20), true); // 2000 left
  assert.equal(backgroundReadAllowed(known(10000, 8001), 20), false); // 1999 left
  assert.equal(backgroundReadAllowed(known(10000, 8001, 0), 0), true); // reserve 0 never blocks
  assert.equal(backgroundReadAllowed(known(10000, 7000, 1500), 20), false); // 1500 left after local lag
  assert.equal(backgroundReadAllowed({ known: false, cloudConnected: false }, 90), true);
});
