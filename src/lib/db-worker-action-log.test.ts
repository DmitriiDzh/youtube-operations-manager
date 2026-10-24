import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, insertWorkerActionLogEntry, listWorkerActionLogEntries, type AppDb } from "@/lib/db";

// WORKER_CAPABILITIES_PLAN.md AC-WK-08 (schema v107): one channel's rows only, newest first, at most the asked number, 90 days.

test("AC-WK-08 (real database, v107): the worker log keeps 90 days per channel, newest first, bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worker-action-log-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const day = 24 * 60 * 60_000;
    const now = new Date("2026-10-24T12:00:00Z");
    const row = (at: Date, channelId: string, target: string) =>
      ({ at, channelId, tokenId: "t", tool: "playlist_update", target, detail: null, outcome: "ok", errorCode: null }) as const;
    await insertWorkerActionLogEntry(row(new Date(now.getTime() - 91 * day), "UC_T", "old"), database);
    await insertWorkerActionLogEntry(row(new Date(now.getTime() - 89 * day), "UC_T", "kept"), database);
    await insertWorkerActionLogEntry(row(new Date(now.getTime() - 1 * day), "UC_J", "japan"), database);
    await insertWorkerActionLogEntry(row(now, "UC_T", "newest"), database);

    assert.deepEqual(
      (await listWorkerActionLogEntries("UC_T", 100, database, now)).map((entry) => entry.target),
      ["newest", "kept"]
    );
    assert.deepEqual(
      (await listWorkerActionLogEntries("UC_T", 1, database, now)).map((entry) => entry.target),
      ["newest"]
    );
    assert.deepEqual(
      (await listWorkerActionLogEntries("UC_J", 100, database, now)).map((entry) => entry.target),
      ["japan"]
    );
    const stored = await client.execute("SELECT COUNT(*) AS n FROM worker_action_log WHERE target = 'old'");
    assert.equal(Number(stored.rows[0].n), 0, "a row past 90 days is pruned on insert");
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
