import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  deleteReviewNotifyLedgerBefore,
  getReviewNotifySettingsJson,
  initializeDatabaseSchema,
  insertReviewNotifyLedgerEntries,
  listReviewNotifyLedgerKeys,
  SCHEMA_MIGRATIONS,
  setReviewNotifySettingsJson,
} from "@/lib/db";

// BL-248 (ADR 0066, REVIEW_NOTIFY_PLAN.md §5): schema v120 adds `review_notify_ledger` -- one row per decision already written into
// the Producer's Inbox. A key recorded twice keeps its first row (a retry never changes which file a decision went into).

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-review-notify-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("schema v120 exists and creates review_notify_ledger", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 120));
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_notify_ledger'");
    assert.equal(t.rows.length, 1);
  });
});

test("ledger keys round-trip; a second record of a key keeps the first file; retention by record time", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await insertReviewNotifyLedgerEntries([{ key: "clip|UC1|c1|d1", kind: "clip", fileName: "A.md" }], new Date("2026-08-01T00:00:00Z"), database);
    await insertReviewNotifyLedgerEntries(
      [
        { key: "clip|UC1|c1|d1", kind: "clip", fileName: "B.md" },
        { key: "plan|v|p|i|a|t|accepted", kind: "plan", fileName: "P.md" },
      ],
      new Date("2026-11-08T00:00:00Z"),
      database
    );
    assert.deepEqual([...(await listReviewNotifyLedgerKeys(["clip|UC1|c1|d1", "plan|v|p|i|a|t|accepted", "clip|UC1|c1|d2"], database))].sort(), ["clip|UC1|c1|d1", "plan|v|p|i|a|t|accepted"]);
    const row = await client.execute("SELECT file_name FROM review_notify_ledger WHERE entry_key = 'clip|UC1|c1|d1'");
    assert.equal(row.rows[0].file_name, "A.md");
    assert.equal(await deleteReviewNotifyLedgerBefore(new Date("2026-09-01T00:00:00Z"), database), 1);
    assert.deepEqual([...(await listReviewNotifyLedgerKeys(["clip|UC1|c1|d1", "plan|v|p|i|a|t|accepted"], database))], ["plan|v|p|i|a|t|accepted"]);
  });
});

test("the settings row round-trips on this computer", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    assert.equal(await getReviewNotifySettingsJson(database), null);
    await setReviewNotifySettingsJson('{"enabled":false,"inboxPath":null}', database);
    assert.equal(await getReviewNotifySettingsJson(database), '{"enabled":false,"inboxPath":null}');
  });
});
