import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  clearStoredGeminiCredentials,
  getGeminiMediaJob,
  getGeminiMediaJobByRequest,
  getGeminiMediaSettingsJson,
  getStoredGeminiCredentials,
  initializeDatabaseSchema,
  insertGeminiMediaJob,
  listGeminiMediaJobs,
  SCHEMA_MIGRATIONS,
  setGeminiMediaSettingsJson,
  updateGeminiMediaJob,
  upsertStoredGeminiCredentials,
  type AppDb,
} from "@/lib/db";

// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §2.2, AC-GM-16) on a real migrated database: schema v83 converges when run
// again; one key row; a request id is unique per creator (none = no constraint); a job moves only from the status it is in.

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-gemini-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const job = (jobId: string, overrides: Record<string, unknown> = {}) => ({
  jobId,
  channelId: "UC1",
  requestId: null as string | null,
  requestHash: "h",
  kind: "image" as const,
  model: "gemini-nano-banana-2.1",
  prompt: "a cat",
  paramsJson: "{}",
  inputsJson: "[]",
  status: "queued" as const,
  estimateUsd: 0.0656,
  attempts: 0,
  createdBy: "factory",
  createdAt: new Date("2026-10-10T12:00:00.123Z"),
  updatedAt: new Date("2026-10-10T12:00:00.123Z"),
  ...overrides,
});

test("schema v83: a second run converges; both tables exist", () =>
  withDb(async (_database, client) => {
    const v83 = SCHEMA_MIGRATIONS.find((m) => m.version === 83);
    assert.ok(v83);
    await v83.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    assert.ok(names.includes("gemini_credentials") && names.includes("gemini_media_jobs"));
  }));

test("credentials: one row, replaced in place, cleared; settings JSON round-trips", () =>
  withDb(async (database) => {
    assert.equal(await getStoredGeminiCredentials(database), null);
    await upsertStoredGeminiCredentials({ ciphertext: "c1", iv: "i", authTag: "t", keyHint: "abcd", status: "ok", verifiedAt: new Date("2026-10-10T12:00:00Z") }, database);
    await upsertStoredGeminiCredentials({ ciphertext: "c2", iv: "i", authTag: "t", keyHint: "wxyz", status: "payment_required", verifiedAt: null }, database);
    const row = await getStoredGeminiCredentials(database);
    assert.deepEqual([row?.ciphertext, row?.keyHint, row?.status, row?.verifiedAt], ["c2", "wxyz", "payment_required", null]);
    await clearStoredGeminiCredentials(database);
    assert.equal(await getStoredGeminiCredentials(database), null);
    assert.equal(await getGeminiMediaSettingsJson(database), null);
    await setGeminiMediaSettingsJson('{"enabled":true}', database);
    assert.equal(await getGeminiMediaSettingsJson(database), '{"enabled":true}');
  }));

test("jobs: a request id is unique per creator; jobs without one never collide; listed newest first with filters", () =>
  withDb(async (database) => {
    assert.equal(await insertGeminiMediaJob(job("gm_1", { requestId: "r1" }), database), true);
    assert.equal(await insertGeminiMediaJob(job("gm_2", { requestId: "r1" }), database), false, "same creator + request id");
    assert.equal(await insertGeminiMediaJob(job("gm_3", { requestId: "r1", createdBy: "owner" }), database), true, "another creator");
    assert.equal(await insertGeminiMediaJob(job("gm_4", { createdAt: new Date("2026-10-11T00:00:00Z") }), database), true);
    assert.equal(await insertGeminiMediaJob(job("gm_5", { channelId: "UC2", createdAt: new Date("2026-10-09T00:00:00Z") }), database), true);
    assert.equal((await getGeminiMediaJobByRequest("factory", "r1", database))?.jobId, "gm_1");
    assert.equal(await getGeminiMediaJobByRequest("factory", "nope", database), null);
    assert.deepEqual((await listGeminiMediaJobs({ limit: 10 }, database)).map((j) => j.jobId), ["gm_4", "gm_3", "gm_1", "gm_5"]);
    assert.deepEqual((await listGeminiMediaJobs({ channelId: "UC2", limit: 10 }, database)).map((j) => j.jobId), ["gm_5"]);
    assert.deepEqual((await listGeminiMediaJobs({ createdSince: new Date("2026-10-10T00:00:00Z"), limit: 10 }, database)).map((j) => j.jobId), ["gm_4", "gm_3", "gm_1"]);
    assert.equal((await getGeminiMediaJob("gm_1", database))?.createdAt.toISOString(), "2026-10-10T12:00:00.123Z", "milliseconds kept");
  }));

test("jobs: an update applies only from the status the job is in (compare-and-set)", () =>
  withDb(async (database) => {
    await insertGeminiMediaJob(job("gm_1"), database);
    assert.equal(await updateGeminiMediaJob("gm_1", "queued", { status: "submitting", attempts: 1 }, database), true);
    assert.equal(await updateGeminiMediaJob("gm_1", "queued", { status: "submitting", attempts: 2 }, database), false, "no longer queued");
    assert.equal(await updateGeminiMediaJob("gm_1", "submitting", { status: "done", costUsd: 0.0542, costBasis: "usage" }, database), true);
    const row = await getGeminiMediaJob("gm_1", database);
    assert.deepEqual([row?.status, row?.attempts, row?.costUsd, row?.costBasis], ["done", 1, 0.0542, "usage"]);
    assert.deepEqual((await listGeminiMediaJobs({ statuses: ["queued", "submitting", "running"], limit: 10 }, database)).map((j) => j.jobId), []);
  }));
