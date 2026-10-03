import assert from "node:assert/strict";
import test from "node:test";
import { parseQuotaBlock } from "@/components/quota-block-dialog";

test("parseQuotaBlock reads the server's quota_insufficient refusal", () => {
  assert.deepEqual(
    parseQuotaBlock({
      error: "quota_insufficient",
      message: "x",
      details: { estimatedUnits: 2340, remainingUnits: 2339, rowsToWrite: 45, fitVideos: 44, resetsAt: "2026-10-04T07:00:00.000Z", canSplit: true },
    }),
    { code: "quota_insufficient", estimatedUnits: 2340, remainingUnits: 2339, rowsToWrite: 45, fitVideos: 44, resetsAt: "2026-10-04T07:00:00.000Z", canSplit: true }
  );
});

test("parseQuotaBlock reads quota_unknown with the Cloud-connected flag, and tolerates missing details", () => {
  assert.deepEqual(parseQuotaBlock({ error: "quota_unknown", details: { estimatedUnits: 520, rowsToWrite: 10, cloudConnected: false } }), {
    code: "quota_unknown",
    estimatedUnits: 520,
    rowsToWrite: 10,
    cloudConnected: false,
  });
  assert.deepEqual(parseQuotaBlock({ error: "quota_unknown" }), { code: "quota_unknown", estimatedUnits: 0, rowsToWrite: 0, cloudConnected: false });
});

test("any other error, or a non-object, is not a quota block", () => {
  assert.equal(parseQuotaBlock({ error: "live_writes_disabled" }), null);
  assert.equal(parseQuotaBlock(null), null);
  assert.equal(parseQuotaBlock("quota_insufficient"), null);
});

test("a non-boolean canSplit is false (never split on a guess)", () => {
  const block = parseQuotaBlock({ error: "quota_insufficient", details: { canSplit: "yes" } });
  assert.equal(block?.code === "quota_insufficient" && block.canSplit, false);
});
