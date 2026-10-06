import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema, SCHEMA_CURRENT_VERSION } from "@/lib/db";

// Phase 14 ⟷ Factory Operator merge (2026-10-05): both branches had numbered migrations 50/51. Phase 14 kept 50–58 (a real
// database already carried them) and Factory Operator became 59/60. The two database states that can exist in the wild
// must both converge to the full current schema, whichever branch's build stamped them:
//   (a) stamped 58 by a Phase 14 build: media tables present, Factory Operator tables absent;
//   (b) stamped 51 by a pre-merge dev build: Factory Operator tables present, media tables absent.
// BL-132 then added v61 (media_control_events, media_exchange_inputs, template source columns, the `media_templates`
// logical-path NAME), so three names are seeded; v62 re-applies v61's last two additions for a database an intermediate
// build stamped 61 (see the test below); v63 adds media_sessions.release_when_done (BL-135). Every path converges to
// SCHEMA_CURRENT_VERSION (v64: BL-133 session GPU plan, capacity wait, capacity log); the two convergence paths are unchanged.

const MEDIA_TABLES = ["media_credentials", "media_sessions", "media_workflow_templates", "media_jobs", "media_exchange_files"];
const FACTORY_TABLES = ["logical_paths", "logical_path_values", "factory_agent_tokens"];

async function tables(client: Client): Promise<Set<string>> {
  const rows = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.rows.map((r) => String(r.name)));
}

async function stamp(client: Client): Promise<number> {
  const rows = await client.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  return Number(rows.rows[0]?.value);
}

async function withDb(run: (client: Client) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-merge-numbering-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("merge numbering: the current schema is 64 with both branches' tables", async () => {
  assert.equal(SCHEMA_CURRENT_VERSION, 64);
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    const t = await tables(client);
    for (const name of [...MEDIA_TABLES, ...FACTORY_TABLES]) assert.ok(t.has(name), name);
    assert.equal(await stamp(client), SCHEMA_CURRENT_VERSION);
  });
});

test("merge numbering (a): a database stamped 58 by a Phase 14 build gains the Factory Operator tables (59/60) and keeps its media rows", async () => {
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    for (const name of FACTORY_TABLES) await client.execute(`DROP TABLE ${name}`);
    await client.execute("INSERT INTO media_sessions (id, channel_id, status, open_slot, requested_by, max_minutes, estimate_usd, fits_today) VALUES ('s1', 'UC1', 'done', NULL, 'operator', 10, 0.1, 1)");
    await client.execute("UPDATE schema_meta SET value = '58' WHERE key = 'schema_version'");
    await initializeDatabaseSchema(client);
    const t = await tables(client);
    for (const name of FACTORY_TABLES) assert.ok(t.has(name), name);
    assert.equal((await client.execute("SELECT count(*) AS n FROM logical_paths")).rows[0].n, 3, "the seeded names (v59: two, v61: media_templates)");
    assert.equal((await client.execute("SELECT count(*) AS n FROM media_sessions")).rows[0].n, 1, "media rows untouched");
    assert.equal(await stamp(client), SCHEMA_CURRENT_VERSION);
  });
});

test("merge numbering (b): a database stamped 51 by a pre-merge dev build gets every Phase 14 table instead of wedging at v53, and keeps its Factory Operator rows", async () => {
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    for (const name of MEDIA_TABLES) await client.execute(`DROP TABLE ${name}`);
    await client.execute("INSERT INTO factory_agent_tokens (id, token_hash, label) VALUES ('t1', 'hash', 'kept')");
    await client.execute("UPDATE schema_meta SET value = '51' WHERE key = 'schema_version'");
    await initializeDatabaseSchema(client);
    const t = await tables(client);
    for (const name of MEDIA_TABLES) assert.ok(t.has(name), name);
    const index = await client.execute("SELECT sql FROM sqlite_master WHERE name = 'media_sessions_open_slot_idx'");
    assert.doesNotMatch(String(index.rows[0].sql), /UNIQUE/, "v58 ran after v51: concurrent sessions allowed");
    assert.equal((await client.execute("SELECT label FROM factory_agent_tokens")).rows[0].label, "kept");
    assert.equal(await stamp(client), SCHEMA_CURRENT_VERSION);
  });
});

test("v62: a database stamped 61 by an intermediate BL-132 build (no models_json, no media_templates name) is completed; a full v61 is unchanged", async () => {
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    await client.execute("DELETE FROM logical_paths WHERE name = 'media_templates'");
    await client.execute("ALTER TABLE media_workflow_templates DROP COLUMN models_json");
    await client.execute("INSERT INTO media_workflow_templates (id, name, version, workflow_json, parameters_json, created_at, updated_at) VALUES ('t1', 'local', 1, '{}', '[]', 0, 0)");
    await client.execute("UPDATE schema_meta SET value = '61' WHERE key = 'schema_version'");
    await initializeDatabaseSchema(client);
    const columns = await client.execute("PRAGMA table_info(media_workflow_templates)");
    assert.ok(columns.rows.some((r) => r.name === "models_json"));
    assert.equal((await client.execute("SELECT count(*) AS n FROM logical_paths WHERE name = 'media_templates'")).rows[0].n, 1);
    assert.equal((await client.execute("SELECT name FROM media_workflow_templates WHERE id = 't1'")).rows[0].name, "local", "rows kept");
    assert.equal(await stamp(client), SCHEMA_CURRENT_VERSION);
    // Running it again on the completed database changes nothing.
    await client.execute("UPDATE schema_meta SET value = '61' WHERE key = 'schema_version'");
    await initializeDatabaseSchema(client);
    assert.equal(await stamp(client), SCHEMA_CURRENT_VERSION);
  });
});
