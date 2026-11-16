import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema } from "../db";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { withTempDir } from "@/test-support/temp-dir";
import { SNAPSHOT_REPLACE_ON_IMPORT_TABLES, type SqlExecutor } from "./contracts";
import { computeContentFingerprint } from "./adapters/fingerprint";
import { scrubDatabaseCopy } from "./adapters/scrub";
import {
  createCachedContentFingerprint,
  ensureTransferredChangeTriggers,
  readTransferredChangeCounters,
  readTransferredChangeKey,
  TRANSFERRED_CHANGE_TRIGGER_PREFIX,
  transferredChangeTriggerName,
} from "./adapters/change-counter";

// BL-270 (owner TG 4662/4665). Requirements: automatic device sync must not read every transferred table every 30 s, yet a change
// to transferred data must never be missed (DEVICE_AUTO_SYNC_PLAN.md §2: a missed change is a silent overwrite on the next import).
// So: any write to a transferred table moves the cheap key; nothing else does; when in doubt the full fingerprint is computed.

async function makeClient(dir: string, name = "live.db"): Promise<Client> {
  const client = createLibsqlClient({ url: `file:${path.join(dir, name)}` });
  await initializeDatabaseSchema(client);
  return client;
}

async function addResearchChannel(client: Client, id: string) {
  await client.execute({ sql: "INSERT INTO research_channels (id, reason, created_via) VALUES (?, ?, ?)", args: [id, "r " + id, "web_ui"] });
}

function countingCompute() {
  const calls = { n: 0 };
  return {
    calls,
    compute: async (client: SqlExecutor) => {
      calls.n++;
      return computeContentFingerprint(client);
    },
  };
}

test("BL-270: every transferred table gets an insert, update and delete trigger and a counter row; a second call installs nothing", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    assert.equal(await ensureTransferredChangeTriggers(client), "installed");
    assert.equal(await ensureTransferredChangeTriggers(client), "ready");
    const triggers = await client.execute("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'");
    const byTable = new Map<string, Set<string>>();
    for (const row of triggers.rows) {
      const set = byTable.get(String(row.tbl_name)) ?? new Set<string>();
      set.add(String(row.name));
      byTable.set(String(row.tbl_name), set);
    }
    const counters = await readTransferredChangeCounters(client);
    for (const table of SNAPSHOT_REPLACE_ON_IMPORT_TABLES) {
      for (const op of ["insert", "update", "delete"] as const) {
        assert.ok(byTable.get(table)?.has(transferredChangeTriggerName(table, op)), `${table} ${op}`);
      }
      assert.equal(counters[table], 0, table);
    }
    // Never on a device-local table.
    assert.equal(byTable.get("app_settings"), undefined);
    client.close();
  }));

test("BL-270: an insert, an update and a delete on a transferred table each move the key; a device-local write does not", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    await ensureTransferredChangeTriggers(client);
    const k0 = await readTransferredChangeKey(client);
    await addResearchChannel(client, "UC1");
    const k1 = await readTransferredChangeKey(client);
    assert.notEqual(k1, k0);
    await client.execute("UPDATE research_channels SET reason = 'changed' WHERE id = 'UC1'");
    const k2 = await readTransferredChangeKey(client);
    assert.notEqual(k2, k1);
    await client.execute("DELETE FROM research_channels WHERE id = 'UC1'");
    const k3 = await readTransferredChangeKey(client);
    assert.notEqual(k3, k2);
    assert.equal((await readTransferredChangeCounters(client)).research_channels, 3);
    // A device-local table (not transferred) leaves the key alone.
    await client.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bl270-test', 'x')");
    assert.equal(await readTransferredChangeKey(client), k3);
    client.close();
  }));

test("BL-270: a write from ANOTHER connection to the same file is counted too", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    await ensureTransferredChangeTriggers(client);
    const before = await readTransferredChangeKey(client);
    const other = createLibsqlClient({ url: `file:${path.join(dir, "live.db")}` });
    await addResearchChannel(other, "UC-other");
    other.close();
    assert.notEqual(await readTransferredChangeKey(client), before);
    client.close();
  }));

test("BL-270: the cached fingerprint is computed once while nothing changes, again after a write, and its value is always the full one", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    const clock = { t: 1_000_000 };
    const { calls, compute } = countingCompute();
    const cached = createCachedContentFingerprint(client, { now: () => clock.t, compute });
    const f1 = await cached.fingerprint();
    clock.t += 30_000;
    const f2 = await cached.fingerprint();
    clock.t += 30_000;
    assert.equal(await cached.fingerprint(), f1);
    assert.equal(f2, f1);
    assert.equal(calls.n, 1, "no write -> no second full read");

    await addResearchChannel(client, "UC1");
    const f3 = await cached.fingerprint();
    assert.equal(calls.n, 2);
    assert.notEqual(f3, f1);
    assert.equal(f3, await computeContentFingerprint(client), "never a stale value");
    client.close();
  }));

test("BL-270: a write that changes nothing (same value) costs one full read and gives the same fingerprint", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    await addResearchChannel(client, "UC1");
    const { calls, compute } = countingCompute();
    const cached = createCachedContentFingerprint(client, { compute });
    const f1 = await cached.fingerprint();
    await client.execute("UPDATE research_channels SET reason = reason WHERE id = 'UC1'");
    assert.equal(await cached.fingerprint(), f1);
    assert.equal(calls.n, 2);
    client.close();
  }));

test("BL-270: even with no write, the full fingerprint is computed again after the safety interval", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    const clock = { t: 0 };
    const { calls, compute } = countingCompute();
    const cached = createCachedContentFingerprint(client, { now: () => clock.t, compute, safetyIntervalMs: 10 * 60_000 });
    await cached.fingerprint();
    clock.t += 10 * 60_000 - 1;
    await cached.fingerprint();
    assert.equal(calls.n, 1);
    clock.t += 1;
    await cached.fingerprint();
    assert.equal(calls.n, 2);
    client.close();
  }));

test("BL-270 (negative): a table rebuilt without its triggers, then written -- the change is still seen at the next call", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    const cached = createCachedContentFingerprint(client);
    const f1 = await cached.fingerprint();
    // What a migration's table rebuild does: the old table and its triggers are dropped; writes then go uncounted.
    for (const op of ["insert", "update", "delete"] as const) {
      await client.execute(`DROP TRIGGER "${transferredChangeTriggerName("research_channels", op)}"`);
    }
    await addResearchChannel(client, "UC-uncounted");
    assert.equal((await readTransferredChangeCounters(client)).research_channels, 0, "the write went uncounted");
    const f2 = await cached.fingerprint();
    assert.notEqual(f2, f1);
    assert.equal(f2, await computeContentFingerprint(client));
    // And the triggers are back.
    assert.equal(await ensureTransferredChangeTriggers(client), "ready");
    client.close();
  }));

test("BL-270 (negative): a write that lands DURING the full computation is not lost -- the next call computes again", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    let writeDuring = true;
    const cached = createCachedContentFingerprint(client, {
      compute: async (c) => {
        const value = await computeContentFingerprint(c);
        if (writeDuring) {
          writeDuring = false;
          await addResearchChannel(client, "UC-during");
        }
        return value;
      },
    });
    const stale = await cached.fingerprint();
    const fresh = await cached.fingerprint();
    assert.notEqual(fresh, stale);
    assert.equal(fresh, await computeContentFingerprint(client));
    client.close();
  }));

test("BL-270 (negative): without the counter table (a database before v123) every call computes in full", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    await client.execute("DROP TABLE transferred_change_counters");
    assert.equal(await ensureTransferredChangeTriggers(client), "unavailable");
    const { calls, compute } = countingCompute();
    const cached = createCachedContentFingerprint(client, { compute });
    await cached.fingerprint();
    await cached.fingerprint();
    assert.equal(calls.n, 2);
    client.close();
  }));

test("BL-270: the scrubbed export copy carries neither the triggers nor the counter table, and stays writable", () =>
  withTempDir("change-counter-", async (dir) => {
    const client = await makeClient(dir);
    await ensureTransferredChangeTriggers(client);
    await addResearchChannel(client, "UC1");
    const copyPath = path.join(dir, "copy.db");
    await copyDatabaseConsistently(client, copyPath);
    await scrubDatabaseCopy(client, copyPath);
    const copy = createLibsqlClient({ url: `file:${copyPath}` });
    const triggers = await copy.execute(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRANSFERRED_CHANGE_TRIGGER_PREFIX}%'`);
    assert.equal(triggers.rows.length, 0);
    const counter = await copy.execute("SELECT name FROM sqlite_master WHERE name = 'transferred_change_counters'");
    assert.equal(counter.rows.length, 0);
    // A write to the copy (what an import's purge of a staged copy does) works.
    await copy.execute("DELETE FROM research_channels");
    copy.close();
    client.close();
  }));
