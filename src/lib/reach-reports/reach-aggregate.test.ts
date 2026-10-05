import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReach, weightedCtr } from "./reach-aggregate";

// CTR is a ratio: clicks = ctr x impressions, combined CTR = total clicks / total impressions.
// All expected numbers below are computed by hand.

test("weightedCtr is impressions-weighted, NOT the arithmetic mean of the CTRs", () => {
  // clicks = 1000*0.05 + 3000*0.01 = 50 + 30 = 80; impressions = 4000 -> 0.02 (a plain mean would be 0.03).
  const result = weightedCtr([
    { impressions: 1000, ctr: 0.05 },
    { impressions: 3000, ctr: 0.01 },
  ]);
  assert.ok(result !== null);
  assert.ok(Math.abs(result - 0.02) < 1e-12, `expected 0.02, got ${result}`);
});

test("weightedCtr ignores rows whose CTR is unknown (neither clicks nor impressions), and is null when none is known", () => {
  // Only the 1000-impression row counts: 1000*0.1/1000 = 0.1.
  const partial = weightedCtr([
    { impressions: 1000, ctr: 0.1 },
    { impressions: 9000, ctr: null },
  ]);
  assert.ok(partial !== null && Math.abs(partial - 0.1) < 1e-12);

  assert.equal(weightedCtr([{ impressions: 500, ctr: null }]), null);
  assert.equal(weightedCtr([]), null);
  // Known CTR but zero impressions gives no denominator.
  assert.equal(weightedCtr([{ impressions: 0, ctr: 0.2 }]), null);
});

test("aggregateReach: daily/videos/totals for a small hand-checked data set", () => {
  const rows = [
    { date: "2026-09-30", videoId: "A", impressions: 1000, ctr: 0.05 },
    { date: "2026-09-30", videoId: "B", impressions: 3000, ctr: 0.01 },
    { date: "2026-10-01", videoId: "A", impressions: 2000, ctr: 0.04 },
  ];

  const result = aggregateReach(rows);

  assert.deepEqual(result.daily.map((d) => [d.date, d.impressions]), [
    ["2026-09-30", 4000],
    ["2026-10-01", 2000],
  ]);
  assert.ok(Math.abs(result.daily[0].ctr! - 0.02) < 1e-12); // (50+30)/4000
  assert.ok(Math.abs(result.daily[1].ctr! - 0.04) < 1e-12);

  // A: 3000 impressions, clicks 50+80=130 -> 130/3000; B: 3000, 30/3000 = 0.01. Tie broken by videoId.
  assert.deepEqual(result.videos.map((v) => [v.videoId, v.impressions]), [
    ["A", 3000],
    ["B", 3000],
  ]);
  assert.ok(Math.abs(result.videos[0].ctr! - 130 / 3000) < 1e-12);
  assert.ok(Math.abs(result.videos[1].ctr! - 0.01) < 1e-12);

  // total: clicks 50+30+80 = 160 over 6000.
  assert.equal(result.totals.impressions, 6000);
  assert.ok(Math.abs(result.totals.ctr! - 160 / 6000) < 1e-12);
});

test("aggregateReach on no rows: empty lists and zero impressions with a null CTR (the caller reports state, not this)", () => {
  assert.deepEqual(aggregateReach([]), { daily: [], videos: [], totals: { impressions: 0, ctr: null } });
});

test("aggregateReach caps the video list at 50, keeping the highest-impression videos", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    date: "2026-09-30",
    videoId: `v${String(i).padStart(2, "0")}`,
    impressions: i + 1,
    ctr: 0.1,
  }));
  const result = aggregateReach(rows);
  assert.equal(result.videos.length, 50);
  assert.equal(result.videos[0].videoId, "v59");
  assert.equal(result.videos[49].videoId, "v10");
  // Totals still cover all 60 rows: 1+2+...+60 = 1830.
  assert.equal(result.totals.impressions, 1830);
});
