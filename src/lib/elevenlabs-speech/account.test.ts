import assert from "node:assert/strict";
import test from "node:test";
import { accountWideUsage, elevenlabsKeyFingerprint } from "./account";

// BL-236 (owner msg 3823; ADR 0039's rule): only computers on the SAME ElevenLabs key (same fingerprint) are summed; a report written
// before today counts for the month only; one from before this month not at all; this computer's own report never twice.

const now = new Date(2026, 9, 29, 15, 0, 0);
const dayStart = new Date(2026, 9, 29);
const monthStart = new Date(2026, 9, 1);
const fp = elevenlabsKeyFingerprint("sk_same_key_0123456789abcdef");
const report = (deviceId: string, fingerprint: string | null, at: Date, today: number, month: number) => ({ deviceId, hostname: deviceId, keyFingerprint: fingerprint, updatedAt: at.toISOString(), usedTodayChars: today, usedMonthChars: month, spentTodayUsd: today * 0.00008, spentMonthUsd: month * 0.00008 });

test("the fingerprint is 32 hex characters, equal for the same key and different for another; never the key", () => {
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.equal(elevenlabsKeyFingerprint("sk_same_key_0123456789abcdef"), fp);
  assert.notEqual(elevenlabsKeyFingerprint("sk_other_key_0123456789abcd"), fp);
  assert.ok(!fp.includes("abcdef0123"));
});

test("same-key peers are summed for today and the month; another key, this computer and last month are not", () => {
  const other = elevenlabsKeyFingerprint("sk_other_key_0123456789abcd");
  const result = accountWideUsage({
    peers: [
      report("pc", fp, new Date(2026, 9, 29, 14), 300, 2_000),
      report("laptop", fp, new Date(2026, 9, 28, 20), 500, 1_000), // yesterday: month only
      report("work", other, new Date(2026, 9, 29, 14), 9_999, 9_999), // another key
      report("mac", fp, new Date(2026, 9, 29, 14), 7_777, 7_777), // this computer
      report("old", fp, new Date(2026, 8, 30, 14), 100, 100), // last month
    ],
    ownDeviceId: "mac",
    ownFingerprint: fp,
    dayStart,
    monthStart,
    now,
  });
  assert.deepEqual([result.otherTodayChars, result.otherMonthChars], [300, 3_000]);
  assert.deepEqual(result.otherComputers.map((c) => c.deviceId).sort(), ["laptop", "pc"]);
});

test("no usable key here: nothing is summed", () => {
  const result = accountWideUsage({ peers: [report("pc", fp, now, 300, 300)], ownDeviceId: "mac", ownFingerprint: null, dayStart, monthStart, now });
  assert.deepEqual([result.otherTodayChars, result.otherMonthChars], [0, 0]);
});
