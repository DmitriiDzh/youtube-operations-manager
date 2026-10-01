import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { initializeDatabaseSchema } from "@/lib/db";
import { withTempDir } from "@/test-support/temp-dir";
import { EMPTY_RETENTION_STATE, runRetentionOnce, type RetentionState } from "./runner";

// AC-P13-07: the purge only ever runs after a backup exists; a device that may not mutate is skipped.

function deps(client: ReturnType<typeof createClient>, dir: string, opts: { gate?: () => Promise<void> } = {}) {
  let state: RetentionState = { ...EMPTY_RETENTION_STATE };
  const copies: string[] = [];
  return {
    copies,
    state: () => state,
    deps: {
      client,
      backupsDir: dir,
      copyDatabase: async (_c: unknown, dest: string) => {
        copies.push(dest);
      },
      assertMayMutate: opts.gate ?? (async () => {}),
      loadState: async () => state,
      saveState: async (s: RetentionState) => {
        state = s;
      },
    },
  };
}

test("AC-P13-07: the very first run takes one backup before purging; later runs do not", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    const d = deps(client, dir);
    const first = await runRetentionOnce(d.deps, new Date("2026-10-01T00:00:00Z"));
    assert.equal(d.copies.length, 1);
    assert.equal(first.firstBackupPath, d.copies[0]);
    assert.ok(first.lastResult);
    await runRetentionOnce(d.deps, new Date("2026-10-02T00:00:00Z"));
    assert.equal(d.copies.length, 1);
    client.close();
  }));

test("a failed backup means no purge at all", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    const d = deps(client, dir);
    d.deps.copyDatabase = async () => {
      throw new Error("disk full");
    };
    const state = await runRetentionOnce(d.deps);
    assert.equal(state.lastResult, null);
    assert.match(String(state.lastError), /disk full/);
    assert.equal(state.firstBackupPath, null);
    client.close();
  }));

test("a device that may not mutate (lock / recovery) is skipped without error", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    const d = deps(client, dir, {
      gate: async () => {
        throw new Error("recovery");
      },
    });
    const state = await runRetentionOnce(d.deps);
    assert.equal(d.copies.length, 0);
    assert.equal(state.lastRunAt, null);
    client.close();
  }));

test("AC-P13-07: the backup is taken while the expiring data still exists (before the purge runs)", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    await client.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UCx', 'r', 'web_ui')");
    await client.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES ('old', 'UCx', ?, 0, 'youtube.channels.list', 'web_ui')",
      args: [Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000)],
    });
    const d = deps(client, dir);
    let rowsAtBackup = -1;
    d.deps.copyDatabase = async () => {
      rowsAtBackup = Number((await client.execute("SELECT COUNT(*) AS n FROM market_channel_snapshots")).rows[0].n);
    };
    await runRetentionOnce(d.deps, new Date("2026-10-01T00:00:00Z"));
    assert.equal(rowsAtBackup, 1, "the expiring row was still there when the backup was taken");
    assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM market_channel_snapshots")).rows[0].n), 0);
    client.close();
  }));

// Owner instruction (msg 1139, item 2): every run also scrubs the backups directory.
test("P13: a run scrubs expired API rows from the backup files too", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    const backups = path.join(dir, "backups");
    await mkdir(backups);
    const old = createClient({ url: `file:${path.join(backups, "pre-migration-x.db")}` });
    await initializeDatabaseSchema(old);
    await old.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UCx', 'r', 'web_ui')");
    await old.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES ('old', 'UCx', ?, 0, 'youtube.channels.list', 'web_ui')",
      args: [Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000)],
    });
    old.close();
    const d = deps(client, backups);
    const state = await runRetentionOnce(d.deps, new Date("2026-10-01T00:00:00Z"));
    assert.equal(state.lastBackupsScrubbed, 1);
    const check = createClient({ url: `file:${path.join(backups, "pre-migration-x.db")}` });
    assert.equal(Number((await check.execute("SELECT COUNT(*) AS n FROM market_channel_snapshots")).rows[0].n), 0);
    assert.equal(Number((await check.execute("SELECT COUNT(*) AS n FROM research_channels")).rows[0].n), 1);
    check.close();
    client.close();
  }));

// Review round 8: an export/import/migration that took the lock after the run's first check pauses
// the purge (re-checked inside its write transaction) instead of changing data under it.
test("P13: the purge pauses, changing nothing, if the device stops being mutable before it writes", () =>
  withTempDir("retention-", async (dir) => {
    const client = createClient({ url: `file:${path.join(dir, "r.db")}` });
    await initializeDatabaseSchema(client);
    await client.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UCx', 'r', 'web_ui')");
    await client.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES ('old', 'UCx', ?, 0, 'youtube.channels.list', 'web_ui')",
      args: [Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000)],
    });
    let checks = 0;
    const d = deps(client, dir, {
      gate: async () => {
        checks += 1;
        if (checks > 1) throw new Error("operation lock held");
      },
    });
    const state = await runRetentionOnce(d.deps, new Date("2026-10-01T00:00:00Z"));
    assert.equal(checks, 2, "checked again inside the purge");
    assert.equal(state.lastError, null);
    assert.equal(state.lastRunAt, null, "a paused run is not recorded as a run");
    assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM market_channel_snapshots")).rows[0].n), 1);
    client.close();
  }));
