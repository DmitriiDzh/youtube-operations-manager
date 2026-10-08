// BL-156 acceptance criteria (written from the requirement, not the implementation):
//   - a transaction's connection is closed the moment it ends (commit, rollback, close, or a failed
//     drizzle callback) -- nothing is left for the GC, whose finalizer can SIGSEGV the process;
//   - commit/rollback keep their SQL meaning (visible / discarded);
//   - the client's own connection survives a transaction, so PRAGMAs set on it stay in force;
//   - a transaction connection waits `SQLITE_BUSY_TIMEOUT_MS` (5000 ms) on a locked database;
//   - anything still open is closed by `closeAllOpenLibsqlClients` (what the process-exit hook runs);
//   - `close()` never takes the driver's double-close path: the driver double-closes exactly when it
//     destroys the connection inside `close()` itself, and closes once when a statement outlives
//     `close()` -- so the database file must still be open right after `close()` and be released
//     only once the garbage collector has run (observed through the process's open descriptors).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { withTempDir } from "@/test-support/temp-dir";
import { closeAllOpenLibsqlClients, countOpenLibsqlClients, createLibsqlClient, SQLITE_BUSY_TIMEOUT_MS } from ".";

async function withClient(fn: (client: ReturnType<typeof createLibsqlClient>, dir: string) => Promise<void>) {
  await withTempDir("libsql-client-", async (dir) => {
    const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
    try {
      await client.execute("CREATE TABLE t (v INTEGER)");
      await fn(client, dir);
    } finally {
      client.close();
    }
  });
}

async function values(client: ReturnType<typeof createLibsqlClient>): Promise<number[]> {
  return (await client.execute("SELECT v FROM t ORDER BY v")).rows.map((row) => Number(row.v));
}

test("a committed transaction's writes are visible and its connection is closed", () =>
  withClient(async (client) => {
    const before = countOpenLibsqlClients();
    const tx = await client.transaction("write");
    assert.equal(countOpenLibsqlClients(), before + 1);
    await tx.execute({ sql: "INSERT INTO t VALUES (?)", args: [1] });
    await tx.commit();
    assert.equal(countOpenLibsqlClients(), before);
    assert.equal(tx.closed, true);
    await assert.rejects(() => tx.execute("SELECT 1"), { code: "TRANSACTION_CLOSED" });
    assert.deepEqual(await values(client), [1]);
  }));

test("rollback and close() discard the writes and close the connection", () =>
  withClient(async (client) => {
    const before = countOpenLibsqlClients();
    const rolledBack = await client.transaction("write");
    await rolledBack.execute("INSERT INTO t VALUES (1)");
    await rolledBack.rollback();
    const closed = await client.transaction("write");
    await closed.execute("INSERT INTO t VALUES (2)");
    closed.close();
    assert.equal(countOpenLibsqlClients(), before);
    assert.deepEqual(await values(client), []);
  }));

test("drizzle's transaction: a throwing callback is rolled back, a returning one committed, neither leaks a connection", () =>
  withClient(async (client) => {
    const db = drizzle(client);
    const before = countOpenLibsqlClients();
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.run(sql`INSERT INTO t VALUES (1)`);
          throw new Error("boom");
        }),
      /boom/
    );
    await db.transaction(async (tx) => {
      await tx.run(sql`INSERT INTO t VALUES (2)`);
    });
    assert.equal(countOpenLibsqlClients(), before);
    assert.deepEqual(await values(client), [2]);
  }));

test("a transaction batch failing on statement 2 reports index 1 and leaves the transaction to roll back", () =>
  withClient(async (client) => {
    const tx = await client.transaction("write");
    await assert.rejects(() => tx.batch(["INSERT INTO t VALUES (1)", "INSERT INTO missing VALUES (1)"]), { statementIndex: 1 });
    await tx.rollback();
    assert.deepEqual(await values(client), []);
  }));

test("the client's own connection keeps its PRAGMAs across a transaction; the transaction's waits SQLITE_BUSY_TIMEOUT_MS", () =>
  withClient(async (client) => {
    await client.execute("PRAGMA busy_timeout = 1234");
    const tx = await client.transaction("write");
    const txTimeout = Number((await tx.execute("PRAGMA busy_timeout")).rows[0][0]);
    await tx.commit();
    assert.equal(SQLITE_BUSY_TIMEOUT_MS, 5000);
    assert.equal(txTimeout, 5000);
    assert.equal(Number((await client.execute("PRAGMA busy_timeout")).rows[0][0]), 1234);
  }));

test("transaction() on a closed client is refused without opening a connection", () =>
  withClient(async (client) => {
    client.close();
    const before = countOpenLibsqlClients();
    await assert.rejects(() => client.transaction("write"), { code: "CLIENT_CLOSED" });
    assert.equal(countOpenLibsqlClients(), before);
  }));

test("closeAllOpenLibsqlClients closes a client nobody closed, and an open transaction's connection", () =>
  withTempDir("libsql-client-", async (dir) => {
    const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
    await client.execute("CREATE TABLE t (v INTEGER)");
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO t VALUES (1)");
    closeAllOpenLibsqlClients();
    assert.equal(client.closed, true);
    assert.equal(countOpenLibsqlClients(), 0);
    const reopened = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
    try {
      assert.deepEqual((await reopened.execute("SELECT v FROM t")).rows.length, 0, "the uncommitted insert must not survive");
    } finally {
      reopened.close();
    }
  }));

v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc") as () => void;

/** Lets the garbage collector run and Node deliver the native finalizers (they run from the event loop). */
async function collectGarbage(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    forceGc();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const openDescriptors = () => readdirSync("/dev/fd").length;

test(
  "close() after every earlier statement was garbage-collected still leaves the connection to a statement, released by the next GC",
  { skip: process.platform === "win32" ? "counts POSIX file descriptors" : false },
  () =>
    withTempDir("libsql-client-", async (dir) => {
      const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
      await client.execute("CREATE TABLE t (v INTEGER)");
      await client.execute("SELECT v FROM t");
      await collectGarbage();
      const beforeClose = openDescriptors();
      client.close();
      assert.equal(openDescriptors(), beforeClose, "the driver must not destroy the connection inside close()");
      await collectGarbage();
      assert.equal(openDescriptors(), beforeClose - 1, "the database file is released once the last statement is collected");
    })
);

test(
  "a finished transaction's connection is released by the next GC, not left open",
  { skip: process.platform === "win32" ? "counts POSIX file descriptors" : false },
  () =>
    withClient(async (client) => {
      await collectGarbage();
      const before = openDescriptors();
      const tx = await client.transaction("write");
      await tx.execute("INSERT INTO t VALUES (1)");
      assert.equal(openDescriptors() > before, true, "the transaction runs on its own connection");
      await tx.commit();
      await collectGarbage();
      assert.equal(openDescriptors(), before);
    })
);
