import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  claimMediaJobPeerCommand,
  finishMediaJobPeerCommand,
  initializeDatabaseSchema,
  insertMediaJobCommandOut,
  knownMediaJobPeerCommandIds,
  listMediaJobCommandsOut,
  listMediaJobPeerCommands,
  SCHEMA_CURRENT_VERSION,
  type AppDb,
} from "@/lib/db";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §3) on a real migrated database: schema v93 adds the outgoing commands and the
// received-commands ledger; a command id can be taken only once (the guard against applying a command twice), a result is
// recorded only on a taken row, and old rows are dropped when listed.

async function withDb(run: (database: AppDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-job-commands-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    // Run again: the migration converges.
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("schema v93: the command tables exist and the schema is at least v93", async () => {
  assert.ok(SCHEMA_CURRENT_VERSION >= 93);
  await withDb(async (database) => {
    assert.deepEqual(await listMediaJobCommandsOut("2000-01-01T00:00:00.000Z", 10, database), []);
    assert.deepEqual(await listMediaJobPeerCommands("2000-01-01T00:00:00.000Z", 10, database), []);
  });
});

test("a received command is taken once; its result is recorded only from `applying`", async () => {
  await withDb(async (database) => {
    const row = { commandId: "cmd-1", issuerDeviceId: "B", issuedOn: "PC", kind: "cancel_job", targetJson: "{}", issuedAt: "2026-10-14T12:00:00.000Z", receivedAt: "2026-10-14T12:01:00.000Z" };
    assert.equal(await claimMediaJobPeerCommand(row, database), true);
    assert.equal(await claimMediaJobPeerCommand(row, database), false);
    assert.deepEqual([...(await knownMediaJobPeerCommandIds(["cmd-1", "cmd-2"], database))], ["cmd-1"]);
    await finishMediaJobPeerCommand("cmd-1", { status: "applied", code: null, jobId: "mj_1", finishedAt: "2026-10-14T12:01:01.000Z" }, database);
    // A second result never overwrites the first.
    await finishMediaJobPeerCommand("cmd-1", { status: "refused", code: "x", jobId: null, finishedAt: "2026-10-14T12:02:00.000Z" }, database);
    const [stored] = await listMediaJobPeerCommands("2026-10-01T00:00:00.000Z", 10, database);
    assert.equal(stored.status, "applied");
    assert.equal(stored.jobId, "mj_1");
  });
});

test("listing drops rows older than the window, newest first", async () => {
  await withDb(async (database) => {
    for (const [id, at] of [
      ["cmd-old", "2026-09-01T00:00:00.000Z"],
      ["cmd-a", "2026-10-14T10:00:00.000Z"],
      ["cmd-b", "2026-10-14T11:00:00.000Z"],
    ]) {
      await insertMediaJobCommandOut({ commandId: id, targetDeviceId: "A", kind: "cancel_job", commandJson: "{}", issuedAt: at }, database);
    }
    assert.deepEqual(
      (await listMediaJobCommandsOut("2026-10-07T00:00:00.000Z", 10, database)).map((r) => r.commandId),
      ["cmd-b", "cmd-a"]
    );
    // The old row was deleted, not only hidden.
    assert.deepEqual(
      (await listMediaJobCommandsOut("2000-01-01T00:00:00.000Z", 10, database)).map((r) => r.commandId),
      ["cmd-b", "cmd-a"]
    );
  });
});
