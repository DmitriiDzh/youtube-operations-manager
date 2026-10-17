import assert from "node:assert/strict";
import test from "node:test";
import type { GeminiSpendReport } from "@/lib/sync-gateway";
import { geminiSpendReportSchema } from "@/lib/sync-gateway";
import { createGeminiSpendSharePublisher } from "./spend-share";

// BL-193 (ADR 0039 §2): this computer publishes its own Gemini spend as a `ytm-gemini-spend` v1 report (device, hostname, key
// fingerprint, today, month, updatedAt) -- rewritten when it changed, and at least every 5 minutes; the figures stay within the
// report's bounds (today ≤ 100 000, month ≤ 1 000 000, never negative). Expected reports are written out by hand.

const FP = "0123456789abcdef0123456789abcdef";

function harness(opts: { deviceId?: string | null; fingerprint?: string | null; failPublish?: boolean } = {}) {
  const spend = { todayUsd: 1.25, monthUsd: 4.5 };
  let fingerprint = opts.fingerprint === undefined ? FP : opts.fingerprint;
  let failPublish = opts.failPublish ?? false;
  const published: GeminiSpendReport[] = [];
  const publish = createGeminiSpendSharePublisher({
    localSpend: async () => ({ ...spend }),
    keyFingerprint: async () => fingerprint,
    deviceId: async () => (opts.deviceId === undefined ? "dev-mac" : opts.deviceId),
    hostname: () => "mac-studio",
    publish: async (report) => {
      if (failPublish) throw new Error("disk full");
      published.push(report);
    },
    now: () => new Date(2026, 9, 16, 12, 0, 0),
  });
  return {
    publish,
    published,
    spend,
    setFingerprint: (value: string | null) => (fingerprint = value),
    setFailPublish: (value: boolean) => (failPublish = value),
  };
}

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 16, h, m, s);

test("the first tick writes the full report, and it passes the family's strict schema", async () => {
  const h = harness();
  assert.equal(await h.publish(at(12, 0)), true);
  assert.deepEqual(h.published, [
    { format: "ytm-gemini-spend", version: 1, deviceId: "dev-mac", hostname: "mac-studio", keyFingerprint: FP, updatedAt: at(12, 0).toISOString(), spentTodayUsd: 1.25, spentMonthUsd: 4.5 },
  ]);
  assert.equal(geminiSpendReportSchema.safeParse(h.published[0]).success, true);
});

test("unchanged figures are not rewritten within 5 minutes, and are rewritten once 5 minutes have passed", async () => {
  const h = harness();
  await h.publish(at(12, 0));
  assert.equal(await h.publish(at(12, 0, 30)), false);
  assert.equal(await h.publish(at(12, 4, 59)), false);
  assert.equal(await h.publish(at(12, 5, 0)), true);
  assert.deepEqual(
    h.published.map((r) => r.updatedAt),
    [at(12, 0).toISOString(), at(12, 5).toISOString()]
  );
});

test("a changed figure or a changed key is written on the next tick, without waiting 5 minutes", async () => {
  const h = harness();
  await h.publish(at(12, 0));
  h.spend.todayUsd = 1.5;
  h.spend.monthUsd = 4.75;
  assert.equal(await h.publish(at(12, 0, 30)), true);
  h.setFingerprint(null); // the key was removed here
  assert.equal(await h.publish(at(12, 1, 0)), true);
  assert.deepEqual(
    h.published.map((r) => [r.spentTodayUsd, r.spentMonthUsd, r.keyFingerprint]),
    [
      [1.25, 4.5, FP],
      [1.5, 4.75, FP],
      [1.5, 4.75, null],
    ]
  );
});

test("a new local day is written at once even when the figures did not change", async () => {
  const h = harness();
  await h.publish(new Date(2026, 9, 16, 23, 59, 50));
  assert.equal(await h.publish(new Date(2026, 9, 17, 0, 0, 20)), true);
  assert.equal(h.published.length, 2);
});

test("no device id yet: nothing is published (the report is per device)", async () => {
  const h = harness({ deviceId: null });
  assert.equal(await h.publish(at(12, 0)), false);
  assert.deepEqual(h.published, []);
});

test("figures out of the report's bounds are clamped: negative or not a number → 0, too large → the bound", async () => {
  const h = harness();
  h.spend.todayUsd = -3;
  h.spend.monthUsd = Number.NaN;
  await h.publish(at(12, 0));
  h.spend.todayUsd = 250_000;
  h.spend.monthUsd = 2_000_000;
  await h.publish(at(12, 1));
  assert.deepEqual(
    h.published.map((r) => [r.spentTodayUsd, r.spentMonthUsd]),
    [
      [0, 0],
      [100_000, 1_000_000],
    ]
  );
  for (const report of h.published) assert.equal(geminiSpendReportSchema.safeParse(report).success, true);
});

test("a failed write is retried on the next tick (it does not count as published)", async () => {
  const h = harness({ failPublish: true });
  await assert.rejects(h.publish(at(12, 0)), /disk full/);
  h.setFailPublish(false);
  assert.equal(await h.publish(at(12, 0, 30)), true);
  assert.equal(h.published.length, 1);
});
