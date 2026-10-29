import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
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
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Bumped with each new migration (v68: BL-143 phase 3 reference ids; v69/v70: BL-157 verdict history and review claims;
// v71: BL-159 per-session minimum and host CUDA columns; v72: BL-161 producer token and call log; v73: BL-162 peer wave notes; v74: BL-163 watchlist pause and agent proposals; v75: BL-166 video milestones; v76: BL-166 fix, milestones without a curve collected again; v77: BL-168 stored traffic and device breakdowns; v78: BL-169 stored search terms; v79: BL-170 experiment arms; v80: BL-171 own-video comments; v81: BL-172 GPU availability log; v82: BL-173 plan re-checks; v83: BL-174 Gemini key and jobs; v84: BL-175 picks and peer picks; v85: BL-175 phase 3 review seconds; v86: BL-176 live streams; v87: BL-181 newest dates returned per collection run; v88: BL-181 basic and traffic-source report rows; v89: BL-182 stage 2 upload queue; v90: BL-184 stage 2 storyboard links on video jobs; v91: removed-on-YouTube mark; v92: BL-186 stream video settings; v93: BL-188 stage 2 media job commands sent and received; v94: BL-191 stored suggesting videos and other channels' titles; v95: BL-194 video numbers and RunPod cost shares; v96: BL-199 the shared device_secrets table; v97: BL-200 a session's runtime and ComfyUI version; v98: FO-REQ-0031 start stage and placement timings; v99: BL-205 live-stream segments; v100: BL-206 GPU availability snapshots and session wait columns; v101: BL-207 live-stream translations; v102: BL-208 availability snapshots per CUDA minimum; v103: BL-209 automatic uploads; v104: BL-210 channel translations; v105: BL-211 live viewer samples; v106: BL-212 broadcast analytics; v107: BL-215 worker action log; v108: BL-220 restart requests and holds; v109: BL-223 channel branding).
test("merge numbering: the current schema is 90 with both branches' tables", async () => {
  // v97: BL-200 media_sessions.runtime_id/comfy_version (a new migration, not a renumbering).
  // v98: FO-REQ-0031 start stage and per-placement timings; v99: BL-205 live-stream segments; v100: BL-206 GPU stats;
  // v101: BL-207 live-stream translations (new migrations); v102: BL-208 snapshots keyed by (at, CUDA minimum);
  // v103: BL-209 publishing_uploads.automatic (a new migration).
  // v104: BL-210 channel_localizations + channel_localization_events (CHANNEL_LOCALIZATIONS_PLAN.md: a new additive migration,
  // not a renumbering -- the expected value follows the requirement "bumped with each new migration").
  // v105: BL-211 live_viewer_samples (LIVE_ANALYTICS_PLAN.md stage 1: a new additive migration).
  // v106: BL-212 live_broadcast_analytics (stage 2: a new additive migration).
  // v107: BL-215 worker_action_log (WORKER_CAPABILITIES_PLAN.md: a new additive migration).
  // v108: BL-220 restart_requests + restart_holds (RESTART_WHEN_IDLE_PLAN.md: a new additive migration).
  // v109: BL-223 channel_branding + channel_branding_events (CHANNEL_BRANDING_PLAN.md: a new additive migration).
  // v110: BL-225 stage 2 publishing_uploads.slot_id.
  // v111: BL-228 system_topic_state + system_topic_commands (SYSTEM_TOPIC_PLAN.md: a new additive migration, not a renumbering).
  // v112: BL-229 part B answers_json on the plan verdict tables (MUSIC_LIBRARY_PLAN.md §3: renumbered from v111 at the merge after BL-228).
  // v113: BL-233 live_streams.bitrate_kbps (FO-REQ-0047: a new additive migration, not a renumbering).
  // v114: BL-234 live_streams.source_mode + live_stream_library_segments (FO-REQ-0048: a new additive migration, not a renumbering).
  // v115: BL-236 channel_voices + elevenlabs_speech_jobs (FO-REQ-0050, ADR 0057: a new additive migration, not a renumbering).
  assert.equal(SCHEMA_CURRENT_VERSION, 115);
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
