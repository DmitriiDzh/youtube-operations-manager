// ---------------------------------------------------------------------------
// The single owner of opening and closing a local libSQL connection (BL-156). Every `src/**` file
// gets its `Client` from `createLibsqlClient` here, never from `@libsql/client`'s own
// `createClient` (enforced by `libsql-client-inventory.test.ts`).
//
// Why: the native driver (`libsql` 0.5.29 -- the newest stable release, which `@libsql/client`
// 0.17 and 0.18 both pin -- built on the `libsql` crate 0.9.30) closes a connection TWICE when the
// connection's last owner is the `Database` object itself: `impl Drop for LibsqlConnection` calls
// `conn.disconnect()` and the field's own `Drop` then calls it again, so `sqlite3_close_v2` runs a
// second time on memory the first call already freed. Usually that read finds stale bytes and
// returns; when the allocator has already unmapped the page the process dies with SIGSEGV.
// Confirmed under a debugger: two `sqlite3_close_v2` calls on one handle, the second from the exact
// frame every crash report shows. It happens when
//   (a) `close()` is called after every statement of that connection was already garbage-collected, or
//   (b) a connection is never closed and the garbage collector (or process exit) finalizes it.
// When a statement object still exists at `close()`, the statement is the last owner instead and
// the driver closes exactly once (also confirmed under the debugger).
// `@libsql/client`'s own `transaction()` produced (b) on every call: it hands the client's current
// connection to the transaction, opens a new one for the client, and nothing ever closes the
// handed-over one. That was the "test failed" (SIGSEGV) hitting a different DB-heavy test file on
// most `npm test` runs, and the same crash could take down the running app.
//
// What this module does about it:
//   1. Closing always goes through `closeSafely`: it runs one trivial statement first, so a
//      statement object exists when the driver's `close()` runs -- the single-close path. (Node
//      runs native finalizers from the event loop, never in the middle of synchronous JS, so the
//      statement cannot be finalized between those two lines.) As before, the file is actually
//      released when the garbage collector reaches that statement, not at `close()` itself.
//   2. `transaction()` runs on a dedicated connection this module owns and always closes when the
//      transaction ends (commit, rollback or close) -- nothing is left for the GC.
//   3. Every connection it opens stays strongly referenced until closed (so an unclosed one can
//      never be finalized mid-run) and is closed, the safe way, on process exit.
// Not covered: a connection whose open fails inside `createClient` itself (nothing to close).
// A side effect worth knowing: the client's own connection is no longer swapped out by its first
// transaction, so per-connection PRAGMAs set on it (`initializeDatabaseSchema`'s `busy_timeout`)
// now stay in force; each transaction connection gets the same `busy_timeout` itself.
// Known cost of that timeout (accepted, no in-process lock added): the driver is synchronous, so a
// statement that waits on a locked database blocks this process's whole event loop while it waits.
// When the lock is held by THIS process -- a write on the main connection, or a second
// `transaction("write")`, issued while one of its own write transactions is still open -- the holder
// cannot make progress during the wait, so the call blocks for the full `SQLITE_BUSY_TIMEOUT_MS`
// (about 5 s) and then fails with SQLITE_BUSY, where `@libsql/client` alone failed at once (its
// transaction connections had no busy timeout). Same outcome, later. The gain is across processes
// (CLI, a second app instance): there the other writer does finish, and the wait succeeds.
// Re-evaluate all of this on a stable `libsql` >= 0.6 (docs/TECHNICAL_DEBT.md RISK-113).
// ---------------------------------------------------------------------------

import {
  createClient,
  LibsqlError,
  LibsqlBatchError,
  type Client,
  type Config,
  type InArgs,
  type InStatement,
  type Replicated,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";

/** How long SQLite retries a locked database before failing with SQLITE_BUSY (see `initializeDatabaseSchema`). */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Every connection opened here and not closed yet, with the safe way to close it. */
const openClients = new Map<object, () => void>();
let exitHookInstalled = false;

function track(client: object, close: () => void): void {
  openClients.set(client, close);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", closeAllOpenLibsqlClients);
  }
}

/** Closes every connection this module opened and nobody closed yet (also runs on process exit). */
export function closeAllOpenLibsqlClients(): void {
  for (const [client, close] of [...openClients]) {
    openClients.delete(client);
    try {
      close();
    } catch {
      // Best effort: one failing close must not keep the rest open.
    }
  }
}

/** How many connections opened here are still open -- for tests. */
export function countOpenLibsqlClients(): number {
  return openClients.size;
}

function beginStatement(mode: TransactionMode): string {
  if (mode === "write") return "BEGIN IMMEDIATE";
  if (mode === "read") return "BEGIN TRANSACTION READONLY";
  if (mode === "deferred") return "BEGIN DEFERRED";
  throw new RangeError('Unknown transaction mode, supported values are "write", "read" and "deferred"');
}

function openRaw(config: Config): Client {
  const raw = createClient(config);
  track(raw, () => closeSafely(raw));
  return raw;
}

/**
 * The only safe way to close a driver connection (see the header): one statement object must exist
 * when the driver's `close()` runs. `execute` prepares and runs its statement synchronously; only
 * its returned promise is asynchronous.
 */
function closeSafely(raw: Client): void {
  if (raw.closed) return;
  void raw.execute("SELECT 1").catch(() => undefined);
  raw.close();
}

function closeRaw(raw: Client): void {
  openClients.delete(raw);
  closeSafely(raw);
}

// Leading whitespace and SQL comments (line comments and block comments), then the first keyword.
const FIRST_SQL_KEYWORD = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*([a-z]*)/i;
/** Statements that, when they SUCCEED, cannot have ended the surrounding transaction. */
const CANNOT_END_TRANSACTION = new Set(["select", "insert", "update", "delete", "replace", "with", "values"]);

/**
 * A transaction on its own connection, which it closes as soon as the transaction ends.
 *
 * Statements run strictly one after another, in the order they were issued, even when the caller
 * does not await each one: every statement waits for the previous one AND for the check that
 * SQLite still has the transaction open. Without that queue, statements issued in the same tick as
 * one that makes SQLite roll back would already have run -- in autocommit mode, written for good.
 */
class DedicatedConnectionTransaction implements Transaction {
  private finished = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: Client) {}

  get closed(): boolean {
    return this.finished;
  }

  private checkNotClosed(): void {
    if (this.finished) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED");
  }

  private end(): void {
    this.finished = true;
    closeRaw(this.connection);
  }

  /** Runs `operation` once everything issued before it has completely finished. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Whether SQLite still has this transaction open. SQLite ends a transaction on its own for
   * `INSERT OR ROLLBACK`, `RAISE(ROLLBACK)` and some failures (disk full, I/O, out of memory); the
   * connection is then in autocommit mode and any further statement would be written for good,
   * outside the transaction the caller asked for. `@libsql/client` does not expose the driver's
   * `inTransaction`, so this asks SQLite directly: `BEGIN` is refused exactly while a transaction
   * is open. If it is not, the transaction is over: close the connection so nothing more can run.
   */
  private async endIfSqliteEndedIt(): Promise<void> {
    if (this.finished) return;
    try {
      await this.connection.execute("BEGIN");
    } catch (error) {
      if (error instanceof Error && /within a transaction/i.test(error.message)) return;
      // Anything else leaves the state unknown -- refuse further statements rather than risk autocommit.
      this.end();
      return;
    }
    // The probe's own BEGIN succeeded: undo it. (`close()` may have closed the connection meanwhile.)
    await this.connection.execute("ROLLBACK").catch(() => undefined);
    this.end();
  }

  /**
   * Runs one statement (already at the head of the queue), then makes sure the transaction is still
   * the one the caller thinks it is: after every failed statement, and after every successful one
   * that is not plainly a query or a data change (COMMIT / END / ROLLBACK end it without any error,
   * whatever comments precede them). Queries and data changes that succeed are not probed, so the
   * usual path costs nothing extra.
   */
  private async runNow(stmt: InStatement): Promise<ResultSet> {
    this.checkNotClosed();
    let result: ResultSet;
    try {
      result = await this.connection.execute(stmt);
    } catch (error) {
      await this.endIfSqliteEndedIt();
      throw error;
    }
    const keyword = FIRST_SQL_KEYWORD.exec(typeof stmt === "string" ? stmt : stmt.sql)?.[1]?.toLowerCase() ?? "";
    if (!CANNOT_END_TRANSACTION.has(keyword)) await this.endIfSqliteEndedIt();
    return result;
  }

  execute(stmt: InStatement): Promise<ResultSet> {
    return this.enqueue(() => this.runNow(stmt));
  }

  batch(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    // One queue entry for the whole batch: nothing issued meanwhile runs between its statements.
    return this.enqueue(async () => {
      const results: ResultSet[] = [];
      for (let i = 0; i < stmts.length; i++) {
        try {
          results.push(await this.runNow(stmts[i]));
        } catch (error) {
          if (error instanceof LibsqlBatchError) throw error;
          if (error instanceof LibsqlError) {
            throw new LibsqlBatchError(error.message, i, error.code, error.extendedCode, error.rawCode, error.cause instanceof Error ? error.cause : undefined);
          }
          throw error;
        }
      }
      return results;
    });
  }

  async executeMultiple(): Promise<void> {
    // `@libsql/client`'s `executeMultiple` on a client rolls back any open transaction when it
    // finishes, so it cannot run inside this one. Nothing in this codebase needs it.
    throw new LibsqlError("executeMultiple is not supported inside a transaction", "TRANSACTION_EXECUTE_MULTIPLE_UNSUPPORTED");
  }

  commit(): Promise<void> {
    return this.enqueue(async () => {
      this.checkNotClosed();
      try {
        await this.connection.execute("COMMIT");
      } catch (error) {
        // A failed COMMIT (e.g. SQLITE_BUSY) normally leaves the transaction open for the caller's
        // rollback; if SQLite has ended it instead, no further statement may run on this connection.
        await this.endIfSqliteEndedIt();
        if (this.finished && error instanceof Error && /no transaction is active/i.test(error.message)) {
          throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED");
        }
        throw error;
      }
      this.end();
    });
  }

  rollback(): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      try {
        await this.connection.execute("ROLLBACK");
      } catch (error) {
        // SQLite may already have rolled back on its own (e.g. after SQLITE_FULL); closing below is what matters.
        if (!(error instanceof Error && /no transaction is active/i.test(error.message))) throw error;
      } finally {
        this.end();
      }
    });
  }

  /**
   * Synchronous, and safe at any moment: the driver runs each statement's SQL synchronously when it
   * is issued, so whatever is "in flight" has already executed and is only waiting for its result;
   * everything still queued behind it finds the transaction closed and is refused.
   */
  close(): void {
    if (this.finished) return;
    // Roll back explicitly: the connection itself is only released once the GC reaches its last
    // statement, and an open write transaction must not keep the database locked until then.
    void this.connection.execute("ROLLBACK").catch(() => undefined);
    this.end();
  }
}

/** A `Client` whose transactions never leak a connection, and which is closed on process exit if nobody closes it. */
class LeakSafeLibsqlClient implements Client {
  constructor(
    private readonly config: Config,
    private readonly inner: Client
  ) {
    track(this, () => closeSafely(this.inner));
  }

  get closed(): boolean {
    return this.inner.closed;
  }

  get protocol(): string {
    return this.inner.protocol;
  }

  execute(stmt: InStatement): Promise<ResultSet>;
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  execute(stmtOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
    return typeof stmtOrSql === "string" ? this.inner.execute(stmtOrSql, args) : this.inner.execute(stmtOrSql);
  }

  batch(stmts: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode): Promise<Array<ResultSet>> {
    return this.inner.batch(stmts, mode);
  }

  migrate(stmts: Array<InStatement>): Promise<Array<ResultSet>> {
    return this.inner.migrate(stmts);
  }

  async transaction(mode: TransactionMode = "write"): Promise<Transaction> {
    if (this.inner.closed) throw new LibsqlError("The client is closed", "CLIENT_CLOSED");
    // A second connection to an in-memory database is a different, empty database.
    if (this.config.url.includes(":memory:")) {
      throw new LibsqlError("transaction() needs a file database (it runs on its own connection)", "TRANSACTION_NEEDS_FILE_DATABASE");
    }
    const begin = beginStatement(mode);
    const connection = openRaw(this.config);
    try {
      await connection.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      await connection.execute(begin);
    } catch (error) {
      closeRaw(connection);
      throw error;
    }
    return new DedicatedConnectionTransaction(connection);
  }

  executeMultiple(sql: string): Promise<void> {
    return this.inner.executeMultiple(sql);
  }

  sync(): Promise<Replicated> {
    return this.inner.sync();
  }

  reconnect(): void {
    // The driver's reconnect closes the current connection itself -- same rule as `closeSafely`.
    if (!this.inner.closed) void this.inner.execute("SELECT 1").catch(() => undefined);
    this.inner.reconnect();
    track(this, () => closeSafely(this.inner));
  }

  close(): void {
    openClients.delete(this);
    closeSafely(this.inner);
  }
}

/** The only way `src/**` opens a libSQL connection -- see the header comment. */
export function createLibsqlClient(config: Config): Client {
  const inner = createClient(config);
  return new LeakSafeLibsqlClient(config, inner);
}
