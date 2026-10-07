import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  createIsolatedDb,
  getGenerationPlan,
  initializeDatabaseSchema,
  insertGenerationPlan,
  linkMediaJobToPlan,
  listGenerationPlanResults,
  listMediaJobsByPlan,
  mediaJobs,
  updateGenerationPlan,
  upsertGenerationPlanResults,
} from "@/lib/db";

// BL-143 schema v66 (ADR 0029): the plan tables and the media_jobs/media_sessions columns, against a real migrated database.

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: ReturnType<typeof createClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "generation-plans-store-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const at = new Date("2026-10-07T10:00:00Z");
const plan = { id: "R-0001-S1", title: "T", channelId: "UC1", owner: "factory" as const, status: "active" as const, budgetUsd: null, budgetGpuMinutes: null, note: null, definitionJson: "{}", revision: 1, createdAt: at, updatedAt: at, closedAt: null };

test("v66 adds the plan columns to media_jobs and media_sessions (nullable) and the three plan tables", () =>
  withDb(async (_db, client) => {
    const cols = async (table: string) => (await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => [r.name, r.notnull]);
    const jobs = await cols("media_jobs");
    for (const name of ["plan_id", "plan_stage_id", "plan_item_key", "plan_seed"]) assert.ok(jobs.some(([n, notnull]) => n === name && notnull === 0), name);
    assert.ok((await cols("media_sessions")).some(([n, notnull]) => n === "plan_id" && notnull === 0));
    for (const table of ["generation_plans", "generation_plan_results", "generation_plan_events"]) assert.ok((await cols(table)).length > 0, table);
  }));

test("a plan id is inserted once; the revision compare-and-swap refuses a stale writer", () =>
  withDb(async (db) => {
    assert.ok(await insertGenerationPlan(plan, db));
    assert.equal(await insertGenerationPlan({ ...plan, title: "other" }, db), null);
    const first = await updateGenerationPlan(plan.id, 1, { title: "A" }, db);
    assert.equal(first?.revision, 2);
    assert.equal(await updateGenerationPlan(plan.id, 1, { title: "B" }, db), null, "stale revision");
    assert.equal((await getGenerationPlan(plan.id, db))?.title, "A");
  }));

test("results are one row per (plan, stage, item, attempt): a repeat replaces every field", () =>
  withDb(async (db) => {
    const row = { planId: plan.id, stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a", result: "rejected", reportedBy: "factory", note: "gap", checksJson: "[1]", at };
    await upsertGenerationPlanResults([row], db);
    await upsertGenerationPlanResults([{ ...row, result: "accepted", note: null, checksJson: null }], db);
    const rows = await listGenerationPlanResults(plan.id, db);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].result, rows[0].note, rows[0].checksJson], ["accepted", null, null]);
  }));

test("linking a job: only a job of the plan's channel that is in no plan yet", () =>
  withDb(async (db) => {
    const job = { sessionId: "s1", templateId: "t", templateVersion: 1, paramsJson: "{}", status: "done" as const, createdBy: "factory" as const };
    await db.insert(mediaJobs).values([
      { ...job, id: "j1", channelId: "UC1" },
      { ...job, id: "j2", channelId: "UC2" },
    ]);
    const link = { planId: plan.id, stageId: "generate", itemKey: "C1/F1", channelId: "UC1" };
    assert.equal(await linkMediaJobToPlan("j2", link, db), false, "another channel's job");
    assert.equal(await linkMediaJobToPlan("j1", link, db), true);
    assert.equal(await linkMediaJobToPlan("j1", { ...link, planId: "other" }, db), false, "already in a plan");
    const linked = await listMediaJobsByPlan(plan.id, db);
    assert.deepEqual(linked.map((j) => [j.id, j.planStageId, j.planItemKey]), [["j1", "generate", "C1/F1"]]);
  }));
