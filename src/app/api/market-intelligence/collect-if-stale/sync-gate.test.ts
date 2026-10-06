import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAfterDeviceSync } from "./sync-gate";

// False divergences (owner, Telegram 2026-10-06): the automatic collection waits for device sync.
// AGENTS.md §M: device sync failing must not switch Market Intelligence collection off.

test("AC-FD-10: sync says go -> the collection runs and its result is returned", async () => {
  let ran = 0;
  const result = await collectAfterDeviceSync({
    syncFirst: async () => ({ allowed: true }),
    collect: async () => {
      ran++;
      return { collected: 3 };
    },
  });
  assert.equal(ran, 1);
  assert.deepEqual(result, { collected: 3 });
});

test("AC-FD-10: sync says wait -> no collection, the reason is returned", async () => {
  let ran = 0;
  const result = await collectAfterDeviceSync({
    syncFirst: async () => ({ allowed: false, reason: "conflict" }),
    collect: async () => {
      ran++;
      return { collected: 3 };
    },
  });
  assert.equal(ran, 0);
  assert.deepEqual(result, { skipped: true, reason: "conflict" });
});

test("AC-FD-10: device sync itself failing never blocks the collection (§M)", async () => {
  let ran = 0;
  await collectAfterDeviceSync({
    syncFirst: async () => {
      throw new Error("device sync broken");
    },
    collect: async () => {
      ran++;
      return {};
    },
  });
  assert.equal(ran, 1);
});
