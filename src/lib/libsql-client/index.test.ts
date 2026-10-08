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

// Review of BL-156: SQLite can end a transaction on its own (INSERT OR ROLLBACK, RAISE(ROLLBACK), disk full).
// Whatever the caller does next must never be written outside the transaction it asked for.
// Hand-derived: t holds 1; 10 is rolled back with the transaction; 20 must be refused -> rows stay [1].
test("after SQLite itself rolls the transaction back, later statements and commit are refused and nothing more is written", () =>
  withClient(async (client) => {
    await client.execute("CREATE TABLE u (v INTEGER UNIQUE)");
    await client.execute("INSERT INTO u VALUES (1)");
    const before = countOpenLibsqlClients();
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO u VALUES (10)");
    await assert.rejects(() => tx.execute("INSERT OR ROLLBACK INTO u VALUES (1)"), { code: "SQLITE_CONSTRAINT" });
    await assert.rejects(() => tx.execute("INSERT INTO u VALUES (20)"), { code: "TRANSACTION_CLOSED" });
    await assert.rejects(() => tx.commit(), { code: "TRANSACTION_CLOSED" });
    assert.equal(tx.closed, true);
    assert.equal(countOpenLibsqlClients(), before, "the transaction's connection is closed");
    assert.deepEqual((await client.execute("SELECT v FROM u ORDER BY v")).rows.map((row) => Number(row.v)), [1]);
  }));

// The opposite boundary: an ordinary failed statement (plain UNIQUE violation) aborts only itself.
// Hand-derived: 1 was there, 10 and 20 are committed -> [1, 10, 20].
test("an ordinary constraint error keeps the transaction alive: later statements and commit succeed", () =>
  withClient(async (client) => {
    await client.execute("CREATE TABLE u (v INTEGER UNIQUE)");
    await client.execute("INSERT INTO u VALUES (1)");
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO u VALUES (10)");
    await assert.rejects(() => tx.execute("INSERT INTO u VALUES (1)"), { code: "SQLITE_CONSTRAINT" });
    assert.equal(tx.closed, false);
    await tx.execute("INSERT INTO u VALUES (20)");
    await tx.commit();
    assert.deepEqual((await client.execute("SELECT v FROM u ORDER BY v")).rows.map((row) => Number(row.v)), [1, 10, 20]);
  }));

test("a batch hitting INSERT OR ROLLBACK stops there (index 1), writes nothing, and closes the transaction", () =>
  withClient(async (client) => {
    await client.execute("CREATE TABLE u (v INTEGER UNIQUE)");
    await client.execute("INSERT INTO u VALUES (1)");
    const tx = await client.transaction("write");
    await assert.rejects(
      () => tx.batch(["INSERT INTO u VALUES (10)", "INSERT OR ROLLBACK INTO u VALUES (1)", "INSERT INTO u VALUES (20)"]),
      { statementIndex: 1 }
    );
    await assert.rejects(() => tx.execute("INSERT INTO u VALUES (30)"), { code: "TRANSACTION_CLOSED" });
    assert.deepEqual((await client.execute("SELECT v FROM u ORDER BY v")).rows.map((row) => Number(row.v)), [1]);
  }));

test("a ROLLBACK or COMMIT sent as a plain statement ends the transaction too", () =>
  withClient(async (client) => {
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO t VALUES (1)");
    await tx.execute("ROLLBACK");
    await assert.rejects(() => tx.execute("INSERT INTO t VALUES (2)"), { code: "TRANSACTION_CLOSED" });
    assert.deepEqual(await values(client), []);
  }));

// The driver is synchronous: a write that meets this process's own open write transaction waits out the
// busy timeout (SQLITE_BUSY_TIMEOUT_MS, blocking the event loop meanwhile) and then fails -- it never hangs.
test("a second write transaction while this process holds one fails with SQLITE_BUSY after the busy timeout, and the first still commits", () =>
  withClient(async (client) => {
    const first = await client.transaction("write");
    await first.execute("INSERT INTO t VALUES (1)");
    const before = countOpenLibsqlClients();
    const startedAt = Date.now();
    await assert.rejects(() => client.transaction("write"), { code: "SQLITE_BUSY" });
    assert.ok(Date.now() - startedAt < 4 * SQLITE_BUSY_TIMEOUT_MS, "must fail, not hang");
    assert.equal(countOpenLibsqlClients(), before, "the refused transaction's connection is closed");
    await first.commit();
    assert.deepEqual(await values(client), [1]);
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
