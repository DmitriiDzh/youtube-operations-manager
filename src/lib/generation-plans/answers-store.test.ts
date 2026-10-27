import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  SCHEMA_MIGRATIONS,
  createIsolatedDb,
  initializeDatabaseSchema,
  insertGenerationPlanPeerVerdict,
  insertGenerationPlanVerdictHistory,
  listGenerationPlanPeerVerdicts,
  listGenerationPlanResults,
  listGenerationPlanVerdictHistory,
  upsertGenerationPlanResults,
} from "@/lib/db";

// BL-229 part B (MUSIC_LIBRARY_PLAN.md §3): schema v111 keeps the owner's answers with a verdict, its history and a verdict sent
// to another computer -- against a real migrated database in a temporary folder.

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plan-answers-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const ANSWERS = JSON.stringify({ "g.no_vocals": true, "g.background": 7, "rj.tempo": "right" });

test("v111 adds a nullable answers_json to the three verdict tables; running it again changes nothing", () =>
  withDb(async (_db, client) => {
    for (const table of ["generation_plan_results", "generation_plan_verdict_history", "generation_plan_peer_verdicts"]) {
      const columns = (await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => [r.name, r.notnull]);
      assert.deepEqual(columns.find(([name]) => name === "answers_json"), ["answers_json", 0], table);
    }
    await SCHEMA_MIGRATIONS.find((m) => m.version === 111)!.apply(client);
  }));

test("answers are written and read back with the verdict, the history row and the peer verdict; absent stays null", () =>
  withDb(async (db) => {
    const at = new Date("2026-10-27T12:00:00Z");
    const base = { planId: "music-014", stageId: "owner_review", attemptRef: "job:1", result: "accepted", reportedBy: "owner", at };
    await upsertGenerationPlanResults([{ ...base, itemKey: "014/V01", answersJson: ANSWERS }, { ...base, itemKey: "014/V02" }], db);
    const rows = await listGenerationPlanResults("music-014", db);
    assert.deepEqual(rows.map((r) => [r.itemKey, r.answersJson]), [["014/V01", ANSWERS], ["014/V02", null]]);
    // A newer verdict on the same attempt without answers clears them (the row keeps only the newest verdict).
    await upsertGenerationPlanResults([{ ...base, itemKey: "014/V01", result: "rejected" }], db);
    assert.equal((await listGenerationPlanResults("music-014", db)).find((r) => r.itemKey === "014/V01")?.answersJson, null);

    await insertGenerationPlanVerdictHistory({ planId: "music-014", itemKey: "014/V01", attemptRef: "job:1", result: "accepted", device: "MAC", at: at.toISOString(), recordedAt: at, answersJson: ANSWERS }, db);
    assert.equal((await listGenerationPlanVerdictHistory("music-014", db))[0].answersJson, ANSWERS);
    await insertGenerationPlanPeerVerdict({ verdictId: "win-0001", planId: "music-014", ownerDeviceId: "mac-1", itemKey: "014/V01", attemptRef: "job:1", result: "accepted", at: at.toISOString(), answersJson: ANSWERS }, db);
    assert.equal((await listGenerationPlanPeerVerdicts("2026-10-01T00:00:00Z", db))[0].answersJson, ANSWERS);
  }));
