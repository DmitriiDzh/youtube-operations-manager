import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema } from "@/lib/db";
import { createRestartWhenIdle } from "../services";
import { createRestartStore, createTableReaders } from "./store";

// BL-220 (RESTART_WHEN_IDLE_PLAN.md AC-RI-01 / AC-RI-02, schema v108): the real tables behind the service. Each busy status the plan
// names is found, a finished row of the same table is not, and `gateway_call_events.occurred_at` (unix SECONDS) becomes milliseconds.

async function withDb(fn: (client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "restart-when-idle-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("AC-RI-01 (real database): the table readers name exactly the busy rows of the plan's statuses", async () => {
  await withDb(async (client) => {
    const readers = createTableReaders(client);
    assert.deepEqual(await readers.mediaSessions(), []);
    assert.equal(await readers.lastMcpCallAt(), null);

    const session = (id: string, status: string) =>
      client.execute({ sql: "INSERT INTO media_sessions (id, channel_id, status, requested_by, max_minutes, estimate_usd, fits_today) VALUES (?, 'UC', ?, 'factory', 30, 1, 1)", args: [id, status] });
    await session("s-pending", "pending");
    await session("s-running", "running");
    await session("s-done", "done");
    await session("s-interrupted", "interrupted");
    // A session still waiting for the owner's approval runs nothing here and survives a restart (plan AC-RI-01, refined).
    assert.deepEqual((await readers.mediaSessions()).sort(), ["s-running"]);

    const job = (id: string, status: string) =>
      client.execute({ sql: "INSERT INTO media_jobs (id, session_id, channel_id, template_id, template_version, params_json, status, created_by) VALUES (?, 's', 'UC', 't', 1, '{}', ?, 'factory')", args: [id, status] });
    for (const status of ["queued", "submitted", "generating", "transferring", "done", "failed", "cancelled"]) await job(`j-${status}`, status);
    assert.deepEqual((await readers.mediaJobs()).sort(), ["j-generating", "j-queued", "j-submitted", "j-transferring"]);

    const rows = (await client.execute("PRAGMA table_info(gemini_media_jobs)")).rows.map((row) => ({ name: String(row.name), notnull: Number(row.notnull), dflt: row.dflt_value }));
    const required = rows.filter((column) => column.notnull === 1 && column.dflt === null && column.name !== "job_id" && column.name !== "status");
    const gemini = async (id: string, status: string) => {
      const columns = ["job_id", "status", ...required.map((column) => column.name)];
      await client.execute({ sql: `INSERT INTO gemini_media_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, args: [id, status, ...required.map(() => 0)] });
    };
    for (const status of ["queued", "submitting", "running", "done", "failed"]) await gemini(`g-${status}`, status);
    assert.deepEqual((await readers.geminiJobs()).sort(), ["g-queued", "g-running", "g-submitting"]);

    const uploadCols = (await client.execute("PRAGMA table_info(publishing_uploads)")).rows.filter((row) => Number(row.notnull) === 1 && row.dflt_value === null).map((row) => String(row.name));
    const upload = async (id: string, status: string) => {
      const others = uploadCols.filter((name) => name !== "id" && name !== "status" && name !== "video" && name !== "channel_id");
      const columns = ["id", "status", "channel_id", "video", ...others];
      await client.execute({ sql: `INSERT INTO publishing_uploads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, args: [id, status, "UC", id, ...others.map(() => 0)] });
    };
    for (const status of ["queued", "uploading", "processing", "finishing", "paused", "done", "failed"]) await upload(`u-${status}`, status);
    assert.deepEqual((await readers.uploads()).sort(), ["u-finishing", "u-processing", "u-uploading"]);

    await client.execute("INSERT INTO gateway_call_events (category, outcome, occurred_at) VALUES ('mcp_tool_calls', 'allowed', 1761300000), ('mcp_tool_calls', 'blocked', 1761300100), ('data_api_reads', 'allowed', 1761309999)");
    assert.equal(await readers.lastMcpCallAt(), 1761300100 * 1000);
  });
});

test("AC-RI-02/06 (real database): a request goes open → restarting → done across two service instances, the hold rows round-trip", async () => {
  await withDb(async (client) => {
    let quiet: number | null = null;
    const store = createRestartStore(client, { get: async () => quiet, set: async (minutes) => void (quiet = minutes) });
    let now = Date.parse("2026-10-24T10:00:00Z");
    let stops = 0;
    let id = 0;
    const make = (build: { version: string; schema: number }) =>
      createRestartWhenIdle({
        store,
        readers: { ...createTableReaders(client), liveStreams: async () => [], operationLock: async () => null, operations: async () => [] },
        clock: () => now,
        newId: () => `r${++id}`,
        serviceMode: () => true,
        build: () => build,
        stop: () => void stops++,
        takeRequestFile: async () => null,
        log: () => undefined,
      });
    const first = make({ version: "1.0.0 (aaaaaaaaaaaa)", schema: 108 });
    const { hold } = await first.hold({ heldBy: "worker:UC_A", minutes: 2, reason: "finishing a plan" });
    await first.request("owner");
    await first.tick();
    assert.equal(stops, 0);
    assert.equal((await first.releaseHold({ holdId: hold.holdId, by: "worker:UC_A" })).released, true);
    await first.setQuietMinutes(7);
    assert.equal(await first.getQuietMinutes(), 7);
    now += 15_000;
    await first.tick();
    assert.equal(stops, 1);

    now += 60_000;
    const second = make({ version: "1.0.0 (bbbbbbbbbbbb)", schema: 109 });
    await second.finalizeBoot();
    const status = await second.status();
    assert.equal(status.request, null);
    assert.equal(status.lastRestart?.status, "done");
    assert.equal(status.lastRestart?.fromVersion, "1.0.0 (aaaaaaaaaaaa)");
    assert.equal(status.lastRestart?.toVersion, "1.0.0 (bbbbbbbbbbbb)");
    assert.equal(status.lastRestart?.toSchema, 109);
    assert.equal(status.lastRestart?.finishedAt, "2026-10-24T10:01:15.000Z");
  });
});
