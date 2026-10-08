import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { countBatchRowsByStatus, createIsolatedDb, initializeDatabaseSchema, listQuotaCalls, pruneQuotaLedger, recordQuotaCall, batches, batchLedgerRows, channels } from "@/lib/db";

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quota-ledger-store-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const base = { service: "data" as const, method: "videos.update", units: 50, outcome: "ok" as const, contextKind: null, contextId: null, contextLabel: null };

test("migration v42 creates quota_ledger with the documented columns, units nullable", () =>
  withDb(async (_db, client) => {
    const info = await client.execute("PRAGMA table_info(quota_ledger)");
    const names = info.rows.map((r) => r.name);
    for (const col of ["id", "occurred_at", "service", "method", "units", "outcome", "context_kind", "context_id", "context_label"]) assert.ok(names.includes(col), col);
    assert.equal(info.rows.find((r) => r.name === "units")?.notnull, 0);
  }));

test("recorded calls come back oldest first, filtered by service and by the since boundary (inclusive)", () =>
  withDb(async (db) => {
    const t = Math.floor(Date.now() / 1000);
    await recordQuotaCall({ ...base, occurredAt: t - 100, method: "a.one" }, db);
    await recordQuotaCall({ ...base, occurredAt: t - 50, method: "a.two", units: null }, db);
    await recordQuotaCall({ ...base, occurredAt: t - 40, service: "analytics", method: "reports.query", units: 1 }, db);
    const data = await listQuotaCalls({ sinceSeconds: t - 100, service: "data" }, db);
    assert.deepEqual(data.map((r) => r.method), ["a.one", "a.two"]);
    assert.equal(data[1].units, null);
    assert.deepEqual((await listQuotaCalls({ sinceSeconds: t - 99, service: "data" }, db)).map((r) => r.method), ["a.two"]);
    assert.deepEqual((await listQuotaCalls({ sinceSeconds: 0, service: "analytics" }, db)).map((r) => r.method), ["reports.query"]);
  }));

test("pruning removes exactly the rows older than 45 days and keeps the boundary row", () =>
  withDb(async (db) => {
    const now = 1_790_000_000;
    const window = 45 * 24 * 3600;
    await recordQuotaCall({ ...base, occurredAt: now - window - 1, method: "just.too.old" }, db);
    await recordQuotaCall({ ...base, occurredAt: now - window, method: "exactly.45.days" }, db);
    await recordQuotaCall({ ...base, occurredAt: now - 10, method: "recent" }, db);
    await pruneQuotaLedger(now, db);
    const methods = (await listQuotaCalls({ sinceSeconds: 0, service: "data" }, db)).map((r) => r.method);
    assert.ok(!methods.includes("just.too.old"));
    assert.ok(methods.includes("exactly.45.days"));
    assert.ok(methods.includes("recent"));
  }));

test("countBatchRowsByStatus counts a batch's ledger rows per status", () =>
  withDb(async (db) => {
    await db.insert(channels).values({ id: "UC1", title: "T", uploadsPlaylistId: "UU1" });
    await db.insert(batches).values({ id: "b1", channelId: "UC1", status: "COMPLETED" });
    for (const [i, status] of ["SUCCESS", "SUCCESS", "FAILED", "PENDING"].entries()) {
      await db.insert(batchLedgerRows).values({ id: `r${i}`, batchId: "b1", videoId: `v${i}`, changeIdsJson: "[]", status });
    }
    assert.deepEqual(await countBatchRowsByStatus("b1", db), { SUCCESS: 2, FAILED: 1, PENDING: 1 });
    assert.deepEqual(await countBatchRowsByStatus("nope", db), {});
  }));
