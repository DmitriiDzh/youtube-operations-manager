import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createFreshnessProbe, msUntilNextProbe, type FreshnessProbeDeps, type FreshnessProbeRow } from "./freshness-probe";

// BL-245 (owner, Telegram 2026-11-06): once an hour, at minute :07 UTC, one channel-level Analytics query per connected channel
// ([today UTC - 5 days, today UTC]); one row per channel per tick with the newest day returned, or the error; a failure never stops
// the next channel; the reads switch off = nothing recorded; ticks never overlap; rows older than 45 days are deleted. Every expected
// value below is worked out by hand.

const NOW = new Date("2026-11-08T04:07:00.000Z");

function fixture(overrides: Partial<FreshnessProbeDeps> & { answers?: Record<string, Array<{ date: string }> | Error> } = {}) {
  const recorded: FreshnessProbeRow[] = [];
  const queries: Array<{ channelId: string; userId: string; startDate: string; endDate: string }> = [];
  const deletedBefore: Date[] = [];
  const issues: string[] = [];
  const answers = overrides.answers ?? {};
  const deps: FreshnessProbeDeps = {
    listChannels: async () => [
      { channelId: "UC1", connectedUserId: "u1" },
      { channelId: "UC2", connectedUserId: null },
      { channelId: "UC3", connectedUserId: "u3" },
    ],
    queryChannelDays: async (args) => {
      queries.push(args);
      const answer = answers[args.channelId] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    store: {
      record: async (row) => void recorded.push(row),
      deleteBefore: async (cutoff) => {
        deletedBefore.push(cutoff);
        return 0;
      },
    },
    clock: { now: () => NOW },
    onIssue: (message) => void issues.push(message),
    ...overrides,
  };
  return { probe: createFreshnessProbe(deps), recorded, queries, deletedBefore, issues };
}

test("one row per connected channel per tick: the newest day returned, the range asked, no row for a channel without a Google user", async () => {
  const { probe, recorded, queries, deletedBefore } = fixture({
    answers: { UC1: [{ date: "2026-11-04" }, { date: "2026-11-06" }, { date: "2026-11-05" }], UC3: [] },
  });
  assert.deepEqual(await probe.tick(), { skipped: null, probed: 2, failed: 0 });
  // 2026-11-08 minus 5 days = 2026-11-03.
  assert.deepEqual(queries, [
    { channelId: "UC1", userId: "u1", startDate: "2026-11-03", endDate: "2026-11-08" },
    { channelId: "UC3", userId: "u3", startDate: "2026-11-03", endDate: "2026-11-08" },
  ]);
  assert.deepEqual(recorded, [
    { channelId: "UC1", probedAt: NOW, requestedStartDate: "2026-11-03", requestedEndDate: "2026-11-08", newestChannelDate: "2026-11-06", error: null },
    { channelId: "UC3", probedAt: NOW, requestedStartDate: "2026-11-03", requestedEndDate: "2026-11-08", newestChannelDate: null, error: null },
  ]);
  // Retention: 45 days before 2026-11-08T04:07Z (8 days of November, 31 of October, 6 of September) = 2026-09-24T04:07Z.
  assert.deepEqual(deletedBefore.map((d) => d.toISOString()), ["2026-09-24T04:07:00.000Z"]);
});

test("a failing channel gets an error row and the next channel is still probed; a long message is cut to 200 characters", async () => {
  const long = "x".repeat(500);
  const { probe, recorded } = fixture({ answers: { UC1: new Error("Request failed with status code 403"), UC3: [{ date: "2026-11-06" }] } });
  assert.deepEqual(await probe.tick(), { skipped: null, probed: 2, failed: 1 });
  assert.deepEqual(
    recorded.map((r) => [r.channelId, r.newestChannelDate, r.error]),
    [
      ["UC1", null, "Request failed with status code 403"],
      ["UC3", "2026-11-06", null],
    ]
  );

  const second = fixture({ answers: { UC1: new Error(long) } });
  await second.probe.tick();
  assert.equal(second.recorded[0].error?.length, 200);
  assert.ok(second.recorded[0].error?.startsWith("xxx"));
});

test("Settings → Analytics reads off: the tick records nothing and asks no further channel", async () => {
  const { probe, recorded, queries } = fixture({
    answers: { UC1: new DomainError({ code: "analytics_reads_disabled", message: "YouTube Analytics API reads are disabled" }) },
  });
  assert.deepEqual(await probe.tick(), { skipped: "analytics_reads_disabled", probed: 0 });
  assert.deepEqual(recorded, []);
  assert.deepEqual(queries.map((q) => q.channelId), ["UC1"]);
});

test("a row that cannot be stored is reported and the next channel is still probed", async () => {
  const recorded: string[] = [];
  const { probe, issues } = fixture({
    answers: { UC1: [{ date: "2026-11-06" }], UC3: [{ date: "2026-11-06" }] },
    store: {
      record: async (row) => {
        if (row.channelId === "UC1") throw new Error("database is locked");
        recorded.push(row.channelId);
      },
      deleteBefore: async () => 0,
    },
  });
  assert.deepEqual(await probe.tick(), { skipped: null, probed: 1, failed: 0 });
  assert.deepEqual(recorded, ["UC3"]);
  assert.deepEqual(issues, ["UC1: probe not recorded: database is locked"]);
});

test("ticks never overlap: a tick while the previous one is still running is skipped; the next one after it runs", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const { probe, recorded } = fixture({
    listChannels: async () => [{ channelId: "UC1", connectedUserId: "u1" }],
    queryChannelDays: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return [{ date: "2026-11-06" }];
    },
  });
  const first = probe.tick();
  assert.deepEqual(await probe.tick(), { skipped: "previous_tick_running" });
  release();
  assert.deepEqual(await first, { skipped: null, probed: 1, failed: 0 });
  assert.deepEqual(await probe.tick(), { skipped: null, probed: 1, failed: 0 });
  assert.equal(recorded.length, 2);
});

test("msUntilNextProbe: the next minute :07 of a UTC hour, strictly after now", () => {
  const at = (iso: string) => msUntilNextProbe(new Date(iso));
  assert.equal(at("2026-11-08T10:00:00.000Z"), 7 * 60_000); // 7 min
  assert.equal(at("2026-11-08T10:06:59.999Z"), 1); // 1 ms
  assert.equal(at("2026-11-08T10:07:00.000Z"), 3_600_000); // exactly :07 -> the next hour's :07
  assert.equal(at("2026-11-08T10:07:00.001Z"), 3_599_999);
  assert.equal(at("2026-11-08T10:59:00.000Z"), 8 * 60_000); // 11:07 is 8 min away
  assert.equal(at("2026-11-08T10:59:59.999Z"), 7 * 60_000 + 1);
  assert.equal(at("2026-11-08T23:30:00.000Z"), 37 * 60_000); // 00:07 of the next day
});
