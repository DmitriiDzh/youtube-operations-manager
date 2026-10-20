import assert from "node:assert/strict";
import test from "node:test";
import type { VideoDetailsSnapshot } from "./contracts";
import { READ_BACK_RETRIES, READ_BACK_RETRY_DELAY_MS, readBackUntilApplied, sameFieldValue } from "./read-back";

const snap = (audio: string | null): VideoDetailsSnapshot => ({ defaultAudioLanguage: audio }) as VideoDetailsSnapshot;

function harness(values: Array<string | null>) {
  let reads = 0;
  const sleeps: number[] = [];
  return {
    reads: () => reads,
    sleeps,
    read: async () => snap(values[Math.min(reads++, values.length - 1)]),
    sleep: async (ms: number) => void sleeps.push(ms),
  };
}

test("owner-chosen policy: 3 retries, 10 seconds apart", () => {
  assert.equal(READ_BACK_RETRIES, 3);
  assert.equal(READ_BACK_RETRY_DELAY_MS, 10_000);
});

test("value already applied on first read: no retry, no sleep", async () => {
  const h = harness(["en"]);
  const result = await readBackUntilApplied({ read: h.read, patch: { defaultAudioLanguage: "en" }, sleep: h.sleep });
  assert.equal(result.defaultAudioLanguage, "en");
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.sleeps, []);
});

test("stale first read, applied on the second: one 10 s pause, then stops", async () => {
  const h = harness(["zxx", "en"]);
  const result = await readBackUntilApplied({ read: h.read, patch: { defaultAudioLanguage: "en" }, sleep: h.sleep });
  assert.equal(result.defaultAudioLanguage, "en");
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.sleeps, [10_000]);
});

test("never applied: exactly 1 + 3 reads, 3 pauses of 10 s, returns the stale snapshot (caller still fails closed)", async () => {
  const h = harness(["zxx"]);
  const result = await readBackUntilApplied({ read: h.read, patch: { defaultAudioLanguage: "en" }, sleep: h.sleep });
  assert.equal(result.defaultAudioLanguage, "zxx");
  assert.equal(h.reads(), 4);
  assert.deepEqual(h.sleeps, [10_000, 10_000, 10_000]);
});

test("applied only on the last allowed retry is still accepted", async () => {
  const h = harness(["zxx", "zxx", "zxx", "en"]);
  const result = await readBackUntilApplied({ read: h.read, patch: { defaultAudioLanguage: "en" }, sleep: h.sleep });
  assert.equal(result.defaultAudioLanguage, "en");
  assert.equal(h.reads(), 4);
});

test("a read error propagates instead of being swallowed", async () => {
  await assert.rejects(
    () => readBackUntilApplied({ read: async () => { throw new Error("boom"); }, patch: { defaultAudioLanguage: "en" }, sleep: async () => {} }),
    /boom/
  );
});

test("tags read back sorted (a live broadcast, observed 2026-10-20) are the tags written; a missing, extra or changed tag is not", () => {
  const written = ["jazz", "cuban jazz", "bossa nova"];
  assert.equal(sameFieldValue("tags", ["bossa nova", "cuban jazz", "jazz"], written), true);
  assert.equal(sameFieldValue("tags", ["bossa nova", "jazz"], written), false);
  assert.equal(sameFieldValue("tags", ["bossa nova", "cuban jazz", "jazz", "latin"], written), false);
  assert.equal(sameFieldValue("tags", ["bossa nova", "Cuban Jazz", "jazz"], written), false);
  assert.equal(sameFieldValue("tags", ["jazz", "jazz", "bossa nova"], written), false);
});
