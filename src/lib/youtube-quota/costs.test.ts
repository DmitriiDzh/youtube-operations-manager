import assert from "node:assert/strict";
import test from "node:test";
import { isWriteMethod, nextYoutubeQuotaReset, quotaUnitsForCall, runWithQuotaContext, currentQuotaContext } from "./index";

// Expected values come from Google's official quota table (determine_quota_cost), not from the implementation.

test("known Data API methods cost what Google's table says", () => {
  const expected: Record<string, number> = {
    "videos.list": 1,
    "videos.update": 50,
    "playlists.insert": 50,
    "playlistItems.delete": 50,
    "channels.list": 1,
    "captions.insert": 400,
    "captions.update": 450,
    "captions.list": 50,
    "search.list": 1,
  };
  for (const [method, units] of Object.entries(expected)) assert.equal(quotaUnitsForCall("data", method), units, method);
  assert.equal(quotaUnitsForCall("analytics", "reports.query"), 1);
});

test("an unknown method has null units, not a guess; Object.prototype names are not methods", () => {
  assert.equal(quotaUnitsForCall("data", "videos.somethingNew"), null);
  assert.equal(quotaUnitsForCall("analytics", "videos.list"), null, "the Data table is not consulted for Analytics");
  assert.equal(quotaUnitsForCall("data", "constructor"), null);
  assert.equal(quotaUnitsForCall("data", "toString"), null);
});

test("write methods are insert/update/delete/rate, reads are not", () => {
  for (const m of ["videos.update", "playlists.insert", "playlistItems.delete", "videos.rate"]) assert.equal(isWriteMethod(m), true, m);
  for (const m of ["videos.list", "reports.query", "search.list"]) assert.equal(isWriteMethod(m), false, m);
});

// Pacific time is UTC-8 in winter (PST) and UTC-7 in summer (PDT). DST ends 2026-11-01 02:00 PDT and starts 2026-03-08 02:00 PST.
test("next reset is the next Pacific midnight (hand-computed instants, summer time)", () => {
  // 2026-10-03 18:00 UTC = 11:00 PDT; next Pacific midnight is 2026-10-04 00:00 PDT = 07:00 UTC.
  assert.equal(nextYoutubeQuotaReset(new Date("2026-10-03T18:00:00Z")).toISOString(), "2026-10-04T07:00:00.000Z");
  // exactly at midnight PDT (07:00 UTC) the day has just started: the next reset is 24 h later.
  assert.equal(nextYoutubeQuotaReset(new Date("2026-10-04T07:00:00Z")).toISOString(), "2026-10-05T07:00:00.000Z");
  assert.equal(nextYoutubeQuotaReset(new Date("2026-10-04T06:59:59Z")).toISOString(), "2026-10-04T07:00:00.000Z");
});

test("next reset across the autumn DST end (2026-11-01 has 25 hours) and the spring DST start (2026-03-08 has 23 hours)", () => {
  // 2026-11-01 00:00 PDT = 07:00 UTC; the next midnight is 2026-11-02 00:00 PST = 08:00 UTC (25 h later).
  assert.equal(nextYoutubeQuotaReset(new Date("2026-11-01T12:00:00Z")).toISOString(), "2026-11-02T08:00:00.000Z");
  // 2026-03-08 00:00 PST = 08:00 UTC; the next midnight is 2026-03-09 00:00 PDT = 07:00 UTC (23 h later).
  assert.equal(nextYoutubeQuotaReset(new Date("2026-03-08T12:00:00Z")).toISOString(), "2026-03-09T07:00:00.000Z");
  // Winter: 2026-12-10 20:00 UTC = 12:00 PST; next midnight 2026-12-11 00:00 PST = 08:00 UTC.
  assert.equal(nextYoutubeQuotaReset(new Date("2026-12-10T20:00:00Z")).toISOString(), "2026-12-11T08:00:00.000Z");
});

test("quota context: calls inside run() see it, nested/concurrent contexts do not mix, outside there is none", async () => {
  assert.equal(currentQuotaContext(), null);
  const seen: Array<string | undefined> = [];
  await Promise.all([
    runWithQuotaContext({ kind: "batch", id: "b1", label: "A" }, async () => {
      await new Promise((r) => setTimeout(r, 15));
      seen.push(currentQuotaContext()?.id ?? undefined);
    }),
    runWithQuotaContext({ kind: "batch", id: "b2", label: "B" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentQuotaContext()?.id ?? undefined);
    }),
  ]);
  assert.deepEqual([...seen].sort(), ["b1", "b2"]);
  assert.equal(currentQuotaContext(), null);
});
