import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { withTempDir } from "@/test-support/temp-dir";
import { runOperationLockCli } from "@/cli/operation-lock";
import { createRecoverableInitializer } from "@/lib/recoverable-initializer";
import { OperationLockError } from "./contracts";
import { clearOperationLockIfUnchanged, describeOperationLock, getOperationLock } from "./services";

// Acceptance criteria (stuck-lock recovery), stated from the requirement rather than the code:
// - An operator can see how long a lock has been held and whether its holder process still runs.
// - Clearing is explicit, and only ever removes the exact lock the operator was shown.
// - A lock whose holder looks alive is refused unless force is requested.
// - The error text tells the operator how to recover.
// - A failed initialization recovers on a later call without restarting the process.

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS app_operation_locks (" +
  "id TEXT PRIMARY KEY, operation_type TEXT NOT NULL, holder_pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)";
const ACQUIRED_AT = "2026-10-01T11:39:49.555Z";
const lock = { id: "singleton" as const, operationType: "migration" as const, holderPid: 26912, acquiredAt: ACQUIRED_AT };
const identity = { operationType: "migration" as const, holderPid: 26912, acquiredAt: ACQUIRED_AT };

async function withLockedDb(
  row: { type: string; pid: number; at: string } | null,
  fn: (client: Client) => Promise<void>
) {
  await withTempDir("op-lock-recovery-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "t.db")}` });
    await client.execute(CREATE_TABLE_SQL);
    if (row) {
      await client.execute({
        sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES ('singleton', ?, ?, ?)",
        args: [row.type, row.pid, row.at],
      });
    }
    try {
      await fn(client);
    } finally {
      client.close();
    }
  });
}

test("describeOperationLock: 90 seconds held by a dead process is stale", () => {
  const now = Date.parse(ACQUIRED_AT) + 90_000;
  const status = describeOperationLock(lock, now, () => false);
  assert.equal(status.elapsedMs, 90_000);
  assert.equal(status.holderAlive, false);
  assert.equal(status.stale, true);
});

test("describeOperationLock: a live holder is not stale; an unparsable timestamp reports 0 elapsed", () => {
  const live = describeOperationLock(lock, Date.parse(ACQUIRED_AT) + 5_000, () => true);
  assert.equal(live.stale, false);
  assert.equal(live.holderAlive, true);
  const garbled = describeOperationLock({ ...lock, acquiredAt: "not a date" }, 1_000, () => true);
  assert.equal(garbled.elapsedMs, 0);
});

test("clear removes a lock whose holder is gone", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const result = await clearOperationLockIfUnchanged(client, identity, { probe: () => false });
    assert.deepEqual(result, { outcome: "cleared" });
    assert.equal(await getOperationLock(client), null);
  }));

test("clear refuses a live holder without force, and removes it with force", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const refused = await clearOperationLockIfUnchanged(client, identity, { probe: () => true });
    assert.equal(refused.outcome, "holder_alive");
    assert.equal((await getOperationLock(client))?.holderPid, 26912);
    const forced = await clearOperationLockIfUnchanged(client, identity, { probe: () => true, force: true });
    assert.deepEqual(forced, { outcome: "cleared" });
    assert.equal(await getOperationLock(client), null);
  }));

test("clear never removes a different lock than the one the operator saw", () =>
  withLockedDb({ type: "import", pid: 4242, at: "2026-10-01T12:00:00.000Z" }, async (client) => {
    // The operator saw the migration lock; by click time an import holds the row instead.
    const result = await clearOperationLockIfUnchanged(client, identity, { probe: () => false, force: true });
    assert.equal(result.outcome, "changed");
    assert.equal((await getOperationLock(client))?.operationType, "import");
  }));

test("clear on an already-released lock reports not_held", () =>
  withLockedDb(null, async (client) => {
    assert.deepEqual(await clearOperationLockIfUnchanged(client, identity), { outcome: "not_held" });
  }));

test("the lock error names how to recover, and flags a dead holder as stale", () => {
  const error = new OperationLockError({ heldBy: lock, stale: true });
  assert.match(error.message, /migration operation is already in progress \(started 2026-10-01T11:39:49\.555Z, pid 26912\)/);
  assert.match(error.message, /stale lock/);
  assert.match(error.message, /\/recovery/);
  assert.match(error.message, /npm run operation-lock/);
});

test("CLI status reports a stale lock without changing it", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const lines: string[] = [];
    const code = await runOperationLockCli(["status"], client, (line) => lines.push(line), () => false);
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /migration lock held since 2026-10-01T11:39:49\.555Z/);
    assert.match(lines.join("\n"), /no longer running \(stale\)/);
    assert.equal((await getOperationLock(client))?.holderPid, 26912);
  }));

test("CLI clear removes a stale lock; refuses a live one; --force needs the typed confirmation", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const log = () => undefined;
    assert.equal(await runOperationLockCli(["clear"], client, log, () => true), 1);
    assert.notEqual(await getOperationLock(client), null);
    assert.equal(await runOperationLockCli(["clear", "--force"], client, log, () => true), 2);
    assert.notEqual(await getOperationLock(client), null);
    assert.equal(await runOperationLockCli(["clear", "--force", "--confirm", "CLEAR"], client, log, () => true), 0);
    assert.equal(await getOperationLock(client), null);
  }));

test("CLI clear removes a stale lock without force", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    assert.equal(await runOperationLockCli(["clear"], client, () => undefined, () => false), 0);
    assert.equal(await getOperationLock(client), null);
  }));

test("recoverable initializer: a failed start is retried on a later call, not before the minimum interval", async () => {
  let clock = 0;
  let calls = 0;
  const initializer = createRecoverableInitializer(
    async () => {
      calls++;
      if (calls === 1) throw new Error("lock held");
    },
    { minRetryIntervalMs: 3_000, now: () => clock }
  );
  await assert.rejects(() => initializer.first, /lock held/);
  await new Promise((resolve) => setImmediate(resolve)); // let the failure be recorded
  clock = 1_000;
  await assert.rejects(() => initializer.get(), /lock held/); // too soon: cached failure
  assert.equal(calls, 1);
  clock = 3_000;
  await initializer.get(); // retry succeeds
  assert.equal(calls, 2);
  await initializer.get(); // success is never restarted
  assert.equal(calls, 2);
});

// wait-idle: the launchers' "never kill the server mid-operation" check.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("wait-idle: no lock means safe to stop immediately", () =>
  withLockedDb(null, async (client) => {
    assert.equal(await runOperationLockCli(["wait-idle"], client, () => undefined, () => true, fakeClock()), 0);
  }));

test("wait-idle: a lock whose holder is gone does not block stopping, and is left in place", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const lines: string[] = [];
    assert.equal(await runOperationLockCli(["wait-idle"], client, (l) => lines.push(l), () => false, fakeClock()), 0);
    assert.match(lines.join("\n"), /interrupted run \(process 26912 is gone\)/);
    assert.notEqual(await getOperationLock(client), null);
  }));

test("wait-idle: waits for a running operation, then reports safe once it releases the lock", () =>
  withLockedDb({ type: "import", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const clock = fakeClock();
    let sleeps = 0;
    const timing = {
      now: clock.now,
      sleep: async (ms: number) => {
        await clock.sleep(ms);
        if (++sleeps === 3) await client.execute("DELETE FROM app_operation_locks");
      },
    };
    const lines: string[] = [];
    assert.equal(await runOperationLockCli(["wait-idle", "--timeout", "30"], client, (l) => lines.push(l), () => true, timing), 0);
    assert.equal(sleeps, 3);
    assert.match(lines[0], /Waiting for the running import operation/);
  }));

test("wait-idle: still running after the timeout means do NOT stop (exit 1), and the lock is untouched", () =>
  withLockedDb({ type: "migration", pid: 26912, at: ACQUIRED_AT }, async (client) => {
    const lines: string[] = [];
    assert.equal(await runOperationLockCli(["wait-idle", "--timeout", "5"], client, (l) => lines.push(l), () => true, fakeClock()), 1);
    assert.match(lines.join("\n"), /still running after 5s; not stopping the app/);
    assert.notEqual(await getOperationLock(client), null);
  }));

test("wait-idle: an invalid timeout is a usage error", () =>
  withLockedDb(null, async (client) => {
    assert.equal(await runOperationLockCli(["wait-idle", "--timeout", "abc"], client, () => undefined, () => true, fakeClock()), 2);
  }));
