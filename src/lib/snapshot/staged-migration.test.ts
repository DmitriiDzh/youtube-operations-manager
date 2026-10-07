import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClient } from "@libsql/client";
import { initializeDatabaseSchema, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { withTempDir } from "@/test-support/temp-dir";
import { migrateStagedCopy, scrubDatabaseCopy } from "@/lib/snapshot";
import { missingTableOf, skippingAbsentDeviceLocalTables } from "@/lib/snapshot/services";

// Owner's Windows computer, 2026-10-06 (Telegram msg 1798): comparing -- and importing -- the Mac's snapshot stamped
// schema 57 failed with "no such table: main.creative_assets". A published snapshot never contains the device-local
// tables (`creative_assets`, `media_credentials`, ...: SNAPSHOT_DEVICE_LOCAL_TABLES), so the 2026-10-05 numbering-
// collision guard took every snapshot stamped 50..58 for a pre-merge dev database and re-ran migrations from 50, and
// v56 indexes `creative_assets`. Requirement: a snapshot from any older build this one supports must stage, with its
// transferred rows intact (AC-SNAP / device handoff), whatever device-local tables it lacks.
// 2026-10-07 (owner's Windows computer, msg 1999): the same failure came back for every snapshot stamped 60..67
// ("no such table: media_jobs" -- v66 alters it; logical_paths, media_sessions, generation_plan_results likewise).
// Every older version is covered, so a future migration touching a device-local table cannot bring it back unnoticed.
const stamps = Array.from({ length: SCHEMA_CURRENT_VERSION - 50 }, (_, i) => 50 + i);
for (const stamp of stamps) test(`a scrubbed snapshot stamped schema ${stamp} (no device-local tables) migrates to the current schema`, () =>
  withTempDir("staged-migration-", async (root) => {
    const live = createClient({ url: `file:${path.join(root, "live.db")}` });
    await initializeDatabaseSchema(live);
    await live.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UC1', 'r', 'web_ui')");
    const staged = path.join(root, "staged.db");
    await copyDatabaseConsistently(live, staged);
    await scrubDatabaseCopy(live, staged);
    live.close();

    const copy = createClient({ url: `file:${staged}` });
    const tables = (await copy.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    assert.ok(!tables.includes("creative_assets") && !tables.includes("media_credentials"), "precondition: the copy is scrubbed like a published snapshot");
    await copy.execute({ sql: "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", args: [String(stamp)] });
    copy.close();

    await migrateStagedCopy(staged);

    const after = createClient({ url: `file:${staged}` });
    assert.deepEqual((await after.execute("SELECT id FROM research_channels")).rows.map((r) => String(r.id)), ["UC1"]);
    after.close();
  }));

// The skip is narrow: only a DEVICE-LOCAL table that is absent. A missing transferred table, or any other error, still fails.
test("on a staged copy only a statement on an absent device-local table is skipped; anything else still fails", () =>
  withTempDir("staged-migration-skip-", async (root) => {
    const raw = createClient({ url: `file:${path.join(root, "empty.db")}` });
    const client = skippingAbsentDeviceLocalTables(raw);
    await client.execute("ALTER TABLE media_jobs ADD COLUMN plan_id TEXT");
    await client.execute("CREATE INDEX IF NOT EXISTS x ON creative_assets(channel_id)");
    await assert.rejects(client.execute("ALTER TABLE research_channels ADD COLUMN x TEXT"), /no such table: research_channels/);
    await assert.rejects(client.execute("SELEC 1"), /syntax error/);
    assert.equal(missingTableOf(new Error("SQLITE_ERROR: no such table: main.creative_assets")), "creative_assets");
    assert.equal(missingTableOf(new Error("SQLITE_ERROR: no such column: x")), null);
    raw.close();
  }));
