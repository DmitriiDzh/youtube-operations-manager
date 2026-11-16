import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, SCHEMA_MIGRATIONS } from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES, SNAPSHOT_TRANSFERRED_TABLES } from "@/lib/snapshot/contracts";

// BL-270 (owner TG 4662/4665): schema v123 adds the device-local change counters of the transferred tables and an index on
// `batch_ledger_rows(status)`, which the background loops look rows up by.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-bl270-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("schema v123: transferred_change_counters exists, is device-local, and batch_ledger_rows has a status index the planner uses", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 123));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.transferred_change_counters, "classified device-local");
  assert.ok(!(SNAPSHOT_TRANSFERRED_TABLES as readonly string[]).includes("transferred_change_counters"), "never in a snapshot");
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transferred_change_counters'");
    assert.equal(t.rows.length, 1);
    const indexes = await client.execute("PRAGMA index_list(batch_ledger_rows)");
    assert.ok(indexes.rows.some((row) => row.name === "batch_ledger_rows_status_idx"));
    const plan = await client.execute("EXPLAIN QUERY PLAN SELECT id FROM batch_ledger_rows WHERE status = 'APPLYING'");
    assert.ok(plan.rows.some((row) => String(row.detail).includes("batch_ledger_rows_status_idx")), JSON.stringify(plan.rows));
  });
});
