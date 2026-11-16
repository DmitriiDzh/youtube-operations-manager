import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "@/lib/db-backup/contracts";
import { waitForExportLockRelease } from "./index";

// Owner msg 4556 (2026-11-16): a Web save during an automatic sync export must wait for the export instead of failing at once;
// an import, a migration or a dead holder's lock is never waited for (the gate refuses those as before).
type Row = { operation_type: string; holder_pid: number; acquired_at: string } | null;

function clientFrom(rows: Row[]): { client: SqlExecutor; reads: () => number } {
  let i = 0;
  const client = {
    execute: async () => {
      const row = rows[Math.min(i, rows.length - 1)];
      i += 1;
      return { rows: row ? [row] : [] };
    },
  } as unknown as SqlExecutor;
  return { client, reads: () => i };
}
const lock = (type: string, pid = 4242): Row => ({ operation_type: type, holder_pid: pid, acquired_at: "2026-11-16T10:44:17.343Z" });

test("a live export: waits until the lock is gone", async () => {
  const { client, reads } = clientFrom([lock("export"), lock("export"), null]);
  const slept: number[] = [];
  await waitForExportLockRelease(client, { alive: () => true, sleep: async (ms) => void slept.push(ms), pollMs: 250 });
  assert.equal(reads(), 3);
  assert.deepEqual(slept, [250, 250]);
});

test("no lock: returns at once", async () => {
  const { client, reads } = clientFrom([null]);
  await waitForExportLockRelease(client, { alive: () => true, sleep: async () => assert.fail("must not sleep") });
  assert.equal(reads(), 1);
});

test("an import or a migration is not waited for", async () => {
  for (const type of ["import", "migration"]) {
    const { client, reads } = clientFrom([lock(type)]);
    await waitForExportLockRelease(client, { alive: () => true, sleep: async () => assert.fail("must not sleep") });
    assert.equal(reads(), 1, type);
  }
});

test("a dead holder's export (stale) is not waited for", async () => {
  const { client } = clientFrom([lock("export")]);
  await waitForExportLockRelease(client, { alive: () => false, sleep: async () => assert.fail("must not sleep") });
});

test("gives up after the timeout (the gate then refuses as before)", async () => {
  const { client } = clientFrom([lock("export")]);
  let clock = 0;
  await waitForExportLockRelease(client, { alive: () => true, timeoutMs: 1000, pollMs: 250, now: () => clock, sleep: async (ms) => void (clock += ms) });
  assert.equal(clock, 1000);
});
