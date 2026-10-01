import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseInitialization, rawSqlClient } from "@/lib/db";
import { getOperationLock } from "@/lib/operation-lock";

// RISK-20 (docs/TECHNICAL_DEBT.md): boot-time schema migration now acquires the operation
// lock (type "migration") around itself. This cannot exercise the acquire/release wiring by
// calling `initializeDatabase` a second time (it runs once at module load, and re-triggering it
// would risk re-running migrations outside their real boot path) -- instead this asserts the
// one property whose absence would be a worse regression than not having the fix at all: the
// lock is never left held after boot completes. A leaked "migration" lock would permanently
// block every export/import/other-migration attempt on this device.
test("boot-time migration does not leave the operation lock held once initialization completes", async () => {
  await databaseInitialization;
  assert.equal(await getOperationLock(rawSqlClient), null);
});

// Automatic device sync, cross-system audit (2026-10-01): exports now hold the operation lock about
// once a minute. Requirements: (1) a process whose schema is already current never needs that lock
// to start -- an MCP/CLI process starting during an export must not lose its DB; (2) a due
// migration waits for a busy lock instead of failing; (3) a lock left by a dead EXPORT process is
// cleared; (4) a dead IMPORT/MIGRATION holder keeps the never-auto-release policy (decision 2b).
import { createClient } from "@libsql/client";
import path from "node:path";
import { acquireMigrationLockIfDue, initializeDatabaseSchema, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { OperationLockError } from "@/lib/operation-lock";
import { withTempDir } from "@/test-support/temp-dir";

const DEAD_PID = 2_147_483_000; // far above any real PID

async function freshClient(dir: string) {
  const client = createClient({ url: `file:${path.join(dir, "boot.db")}` });
  await initializeDatabaseSchema(client);
  return client;
}

async function holdLock(client: ReturnType<typeof createClient>, type: string, pid: number) {
  await client.execute({
    sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES ('singleton', ?, ?, '2026-10-01T00:00:00Z')",
    args: [type, pid],
  });
}

test("boot with a current schema starts while an export holds the lock, without touching it", () =>
  withTempDir("boot-lock-", async (dir) => {
    const client = await freshClient(dir);
    await holdLock(client, "export", process.pid);
    assert.equal(await acquireMigrationLockIfDue(client, { attempts: 0, waitMs: 1 }), false);
    assert.equal((await getOperationLock(client))?.operationType, "export");
    client.close();
  }));

test("a due migration waits for a live holder, and fails with OperationLockError only after waiting", () =>
  withTempDir("boot-lock-", async (dir) => {
    const client = await freshClient(dir);
    await holdLock(client, "export", process.pid);
    setTimeout(() => void client.execute("DELETE FROM app_operation_locks"), 30);
    assert.equal(await acquireMigrationLockIfDue(client, { currentVersion: SCHEMA_CURRENT_VERSION + 1, attempts: 50, waitMs: 10 }), true);
    assert.equal((await getOperationLock(client))?.operationType, "migration");
    await client.execute("DELETE FROM app_operation_locks");
    await holdLock(client, "export", process.pid);
    await assert.rejects(
      () => acquireMigrationLockIfDue(client, { currentVersion: SCHEMA_CURRENT_VERSION + 1, attempts: 2, waitMs: 1 }),
      (error: unknown) => error instanceof OperationLockError
    );
    client.close();
  }));

test("a lock left by a dead export process is cleared; a dead importer's lock is not", () =>
  withTempDir("boot-lock-", async (dir) => {
    const client = await freshClient(dir);
    await holdLock(client, "export", DEAD_PID);
    assert.equal(await acquireMigrationLockIfDue(client, { currentVersion: SCHEMA_CURRENT_VERSION + 1, attempts: 2, waitMs: 1 }), true);
    await client.execute("DELETE FROM app_operation_locks");
    await holdLock(client, "import", DEAD_PID);
    await assert.rejects(
      () => acquireMigrationLockIfDue(client, { currentVersion: SCHEMA_CURRENT_VERSION + 1, attempts: 2, waitMs: 1 }),
      (error: unknown) => error instanceof OperationLockError
    );
    assert.equal((await getOperationLock(client))?.operationType, "import");
    client.close();
  }));
