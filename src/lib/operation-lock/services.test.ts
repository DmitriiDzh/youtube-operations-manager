import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  acquireOperationLock,
  forceClearOperationLock,
  getOperationLock,
  releaseOperationLock,
  withOperationLock,
} from "./services";
import { OperationLockError } from "./contracts";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS app_operation_locks (" +
  "id TEXT PRIMARY KEY, operation_type TEXT NOT NULL, holder_pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)";

async function withTempClient(fn: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operation-lock-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  await client.execute(CREATE_TABLE_SQL);
  try {
    await fn(client);
  } finally {
    client.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

test("acquireOperationLock succeeds when no lock is held, and is readable back", () =>
  withTempClient(async (client) => {
    const lock = await acquireOperationLock(client, "export");
    assert.equal(lock.operationType, "export");
    assert.equal(lock.holderPid, process.pid);

    const read = await getOperationLock(client);
    assert.deepEqual(read, lock);
  }));

test("a second acquire while the lock is held by this same live process is rejected as non-stale", () =>
  withTempClient(async (client) => {
    await acquireOperationLock(client, "export");
    await assert.rejects(
      () => acquireOperationLock(client, "import"),
      (error: unknown) => error instanceof OperationLockError && error.details.stale === false
    );
  }));

test("releaseOperationLock only releases a lock held by this process, then a new acquire succeeds", () =>
  withTempClient(async (client) => {
    await acquireOperationLock(client, "migration");
    await releaseOperationLock(client);
    assert.equal(await getOperationLock(client), null);

    const second = await acquireOperationLock(client, "export");
    assert.equal(second.operationType, "export");
  }));

test("a lock held by a PID that is not running is reported as stale, but is never auto-released", () =>
  withTempClient(async (client) => {
    // A PID astronomically unlikely to be a live process on any test machine.
    const deadPid = 999999;
    await client.execute({
      sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES (?, ?, ?, ?)",
      args: ["singleton", "migration", deadPid, new Date().toISOString()],
    });

    await assert.rejects(
      () => acquireOperationLock(client, "export"),
      (error: unknown) => error instanceof OperationLockError && error.details.stale === true
    );

    // Still held -- acquire must not have auto-cleared it.
    const stillHeld = await getOperationLock(client);
    assert.equal(stillHeld?.holderPid, deadPid);
  }));

test("forceClearOperationLock is the only way a stale lock is cleared, and is an explicit operator action", () =>
  withTempClient(async (client) => {
    const deadPid = 999999;
    await client.execute({
      sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES (?, ?, ?, ?)",
      args: ["singleton", "migration", deadPid, new Date().toISOString()],
    });

    await forceClearOperationLock(client);
    assert.equal(await getOperationLock(client), null);

    const acquired = await acquireOperationLock(client, "import");
    assert.equal(acquired.holderPid, process.pid);
  }));

test("withOperationLock releases the lock even if the wrapped function throws", () =>
  withTempClient(async (client) => {
    await assert.rejects(() =>
      withOperationLock(client, "export", async () => {
        throw new Error("boom");
      })
    );
    assert.equal(await getOperationLock(client), null);
  }));
