import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  initializeDatabaseSchema,
  insertLocalVideoCleanupLog,
  insertPublishingUploads,
  listLocalVideoCleanupLoggedUploadIds,
  listPublishingUploadsForCleanup,
  SCHEMA_MIGRATIONS,
  sumLocalVideoCleanupFreed,
} from "@/lib/db";

// BL-238 (FO-REQ-0051, ADR 0058 §6): schema v116 adds `local_video_cleanup_log` -- one entry per upload (a second is ignored); the
// cleanup's candidates are this channel's `done` uploads finished at or after the switch time with no entry yet.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-cleanup-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  channelId: "UC1",
  video: `V${id}`,
  manifestPath: `04 Videos/11 November/1105 V${id}/V${id}_release.json`,
  manifestSha256: `sha-${id}`,
  packageJson: "{}",
  settingsJson: "{}",
  approvedBy: "user-1",
  approvedAt: new Date(1),
  status: "done" as const,
  totalBytes: 10,
  storedBytes: 10,
  publishAtAtInsert: false,
  stepsJson: "{}",
  attempts: 0,
  createdAt: new Date(1),
  updatedAt: new Date(1),
  finishedAt: new Date(5000),
  ...over,
});

test("schema v116 exists and creates local_video_cleanup_log", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 116));
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_video_cleanup_log'");
    assert.equal(t.rows.length, 1);
  });
});

test("candidates: done, this channel, finished at or after the switch time, not logged", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await insertPublishingUploads(
      [
        row("1"),
        row("2", { finishedAt: new Date(4999) }), // before the switch
        row("3", { status: "failed" }),
        row("4", { channelId: "UC2" }),
        row("5"),
      ],
      database
    );
    await insertLocalVideoCleanupLog({ id: "l1", channelId: "UC1", uploadId: "5", video: "V5", path: "p", bytes: 10, videoId: "v", action: "deleted", reason: null, at: new Date(6000) }, database);
    const found = await listPublishingUploadsForCleanup("UC1", new Date(5000), database);
    assert.deepEqual(found.map((r) => r.id), ["1"]);
  });
});

test("the log keeps one entry per upload; freed counts only deletes", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const entry = { id: "l1", channelId: "UC1", uploadId: "u1", video: "V1", path: "p", bytes: 100, videoId: "v", action: "deleted" as const, reason: null, at: new Date(1) };
    assert.equal(await insertLocalVideoCleanupLog(entry, database), true);
    assert.equal(await insertLocalVideoCleanupLog({ ...entry, id: "l2", action: "refused", reason: "x" }, database), false);
    await insertLocalVideoCleanupLog({ ...entry, id: "l3", uploadId: "u2", bytes: 7, action: "refused", reason: "size_mismatch_youtube" }, database);
    assert.deepEqual([...(await listLocalVideoCleanupLoggedUploadIds("UC1", database))].sort(), ["u1", "u2"]);
    assert.deepEqual(await sumLocalVideoCleanupFreed("UC1", database), { bytes: 100, count: 1 });
  });
});
