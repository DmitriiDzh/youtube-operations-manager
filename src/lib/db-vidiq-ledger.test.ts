import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  expireVidiqPendingRows,
  getVidiqSetting,
  hasVidiqPendingJob,
  initializeDatabaseSchema,
  insertVidiqLedgerRow,
  listVidiqLedgerRows,
  SCHEMA_MIGRATIONS,
  setVidiqSetting,
  updateVidiqLedgerRow,
} from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";

// BL-278 stage 1 (VIDIQ_INTEGRATION_PLAN.md §5 "Schema (stage 1, additive)"): schema v127 adds `vidiq_ledger` -- one row per vidIQ
// call, pruned to 90 days on insert like producer_call_log; device-local; classified not_api_data (hashes, names and numbers).

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-vidiq-ledger-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (at: Date, extra: Partial<Parameters<typeof insertVidiqLedgerRow>[0]> = {}) => ({
  at,
  caller: "owner" as const,
  tool: "vidiq_outliers",
  argsSha256: "a".repeat(64),
  statedCost: 5,
  creditsUsed: null,
  outcome: "pending" as const,
  errorCode: null,
  jobId: null,
  balanceAfter: null,
  ...extra,
});

test("schema v127 exists, creates vidiq_ledger with its index on at, device-local and classified not_api_data", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 127));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.vidiq_ledger);
  assert.equal(YOUTUBE_DATA_CLASSIFICATION.vidiq_ledger?.kind, "not_api_data");
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vidiq_ledger'");
    assert.equal(t.rows.length, 1);
    const i = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vidiq_ledger' AND sql LIKE '%(at)%'");
    assert.equal(i.rows.length, 1);
    const columns = (await client.execute("PRAGMA table_info(vidiq_ledger)")).rows.map((r) => String(r.name)).sort();
    assert.deepEqual(columns, ["args_sha256", "at", "balance_after", "caller", "credits_used", "error_code", "id", "job_id", "outcome", "stated_cost", "tool"].sort());
  });
});

test("insert returns the id, update patches only the given fields, list is newest first", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const t1 = new Date("2026-11-26T10:00:00Z");
    const t2 = new Date("2026-11-26T10:05:00Z");
    const a = await insertVidiqLedgerRow(row(t1), database);
    const b = await insertVidiqLedgerRow(row(t2, { tool: "vidiq_comment_insights", caller: "producer" }), database);
    await updateVidiqLedgerRow(b, { outcome: "job_pending", creditsUsed: 5, jobId: "job-1" }, database);
    await updateVidiqLedgerRow(a, { outcome: "ok", creditsUsed: 5, balanceAfter: 145 }, database);
    const rows = await listVidiqLedgerRows({ limit: 10, now: t2 }, database);
    assert.deepEqual(rows.map((r) => [r.id, r.outcome, r.creditsUsed, r.jobId, r.balanceAfter, r.caller]), [
      [b, "job_pending", 5, "job-1", null, "producer"],
      [a, "ok", 5, null, 145, "owner"],
    ]);
    assert.equal(rows[1].at.getTime(), t1.getTime());
    assert.equal(await hasVidiqPendingJob("job-1", database), true);
    assert.equal(await hasVidiqPendingJob("job-2", database), false);
    assert.deepEqual((await listVidiqLedgerRows({ limit: 10, since: new Date("2026-11-26T10:01:00Z"), now: t2 }, database)).map((r) => r.id), [b]);
  });
});

test("an insert prunes rows older than 90 days", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const now = new Date("2026-11-26T10:00:00Z");
    await insertVidiqLedgerRow(row(new Date(now.getTime() - 91 * 86_400_000)), database);
    await insertVidiqLedgerRow(row(new Date(now.getTime() - 89 * 86_400_000)), database);
    await insertVidiqLedgerRow(row(now), database);
    const count = await client.execute("SELECT count(*) AS n FROM vidiq_ledger");
    assert.equal(Number(count.rows[0].n), 2);
  });
});

test("the four vidIQ settings are stored in app_settings; null removes one; another key is refused", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    assert.equal(await getVidiqSetting("vidiq_enabled", database), null);
    await setVidiqSetting("vidiq_enabled", "true", database);
    await setVidiqSetting("vidiq_monthly_budget_credits", "150", database);
    assert.equal(await getVidiqSetting("vidiq_enabled", database), "true");
    await setVidiqSetting("vidiq_enabled", null, database);
    assert.equal(await getVidiqSetting("vidiq_enabled", database), null);
    assert.equal(await getVidiqSetting("vidiq_monthly_budget_credits", database), "150");
    await setVidiqSetting("vidiq_overcharge_ack_at", "2026-11-28T10:00:00.000Z", database);
    assert.equal(await getVidiqSetting("vidiq_overcharge_ack_at", database), "2026-11-28T10:00:00.000Z");
    await assert.rejects(() => setVidiqSetting("live_writes_enabled" as never, "false", database));
  });
});

test("review 5: pending rows recorded before the cutoff become unknown (vidiq_outcome_unknown, credits still null); others untouched", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const now = new Date("2026-11-28T10:00:00Z");
    const cutoff = new Date(now.getTime() - 15 * 60_000);
    const stale = await insertVidiqLedgerRow(row(new Date(now.getTime() - 16 * 60_000)), database);
    const fresh = await insertVidiqLedgerRow(row(new Date(now.getTime() - 14 * 60_000)), database);
    const done = await insertVidiqLedgerRow(row(new Date(now.getTime() - 30 * 60_000), { outcome: "ok", creditsUsed: 5 }), database);
    assert.equal(await expireVidiqPendingRows(cutoff, database), 1);
    assert.equal(await expireVidiqPendingRows(cutoff, database), 0, "idempotent");
    const byId = new Map((await listVidiqLedgerRows({ limit: 10, now }, database)).map((r) => [r.id, r]));
    assert.deepEqual([byId.get(stale)?.outcome, byId.get(stale)?.errorCode, byId.get(stale)?.creditsUsed], ["unknown", "vidiq_outcome_unknown", null]);
    assert.deepEqual([byId.get(fresh)?.outcome, byId.get(fresh)?.errorCode], ["pending", null]);
    assert.deepEqual([byId.get(done)?.outcome, byId.get(done)?.creditsUsed], ["ok", 5]);
  });
});
