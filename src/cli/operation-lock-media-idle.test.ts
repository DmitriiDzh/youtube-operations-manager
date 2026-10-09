import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDatabaseSchema } from "@/lib/db";
import { createLibsqlClient } from "@/lib/libsql-client";
import { runOperationLockCli } from "./operation-lock";

// FO-MSG-0013 §2: stopping the app terminates every pod this computer runs (AC-P14-09) and fails the jobs queued on it, so the stop
// launchers refuse while a media session is being created or running here. Expected exit codes from that rule: 0 = nothing active,
// 1 = active (listed).

async function client(withSchema: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-idle-"));
  const c = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  if (withSchema) await initializeDatabaseSchema(c);
  return c;
}

async function session(c: Awaited<ReturnType<typeof client>>, id: string, status: string) {
  await c.execute({
    sql: "INSERT INTO media_sessions (id, channel_id, status, requested_by, max_minutes, estimate_usd, fits_today, created_at) VALUES (?, 'UC_ours', ?, 'factory', 60, 1.5, 1, ?)",
    args: [id, status, Math.floor(Date.now() / 1000)],
  });
}

test("media-idle: finished, failed, pending and capacity-waiting sessions do not block stopping (no pod is lost)", async () => {
  const c = await client(true);
  for (const [id, status] of [["s1", "done"], ["s2", "failed"], ["s3", "interrupted"], ["s4", "pending"], ["s5", "waiting_capacity"], ["s6", "rejected"]]) await session(c, id, status);
  assert.equal(await runOperationLockCli(["media-idle"], c, () => undefined), 0);
});

test("media-idle: a session being created, starting, running or stopping blocks stopping, and is named", async () => {
  for (const status of ["approved", "starting", "running", "stopping"]) {
    const c = await client(true);
    await session(c, `live-${status}`, status);
    const lines: string[] = [];
    assert.equal(await runOperationLockCli(["media-idle"], c, (line) => lines.push(line)), 1, status);
    assert.match(lines.join("\n"), new RegExp(`live-${status} \\(${status}, channel UC_ours\\)`));
  }
});

test("media-idle: a database from before media sessions existed counts as none", async () => {
  assert.equal(await runOperationLockCli(["media-idle"], await client(false), () => undefined), 0);
});
