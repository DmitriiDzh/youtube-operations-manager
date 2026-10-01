import { test } from "node:test";
import assert from "node:assert/strict";
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
