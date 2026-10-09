import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import {
  initializeDatabaseSchema,
  insertMediaCapacityAttempt,
  insertMediaSession,
  listMediaCapacityAttempts,
  setMediaCapacityAttemptHostCuda,
  transitionMediaSession,
  upsertFactoryMediaWorkflowTemplate,
  type AppDb,
} from "@/lib/db";

// BL-159 (docs/roadmap/plans/PER_SESSION_CUDA_PLAN.md, schema v71; independent review: the new columns must be checked through
// the real helpers on a migrated database, not only through fakes). Expected values are the plan's: a session keeps its own
// minimum, the minimum its placement used and its host's CUDA (cleared again when it goes back to `approved`); a capacity-log
// row gets ITS OWN host's version by id; a template version that drops its minimum no longer carries it.

async function withDb(run: (database: AppDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-cuda-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("BL-159: a session row keeps its own minimum, the used minimum and the host's CUDA, which going back to approved clears", () =>
  withDb(async (database) => {
    const createdAt = new Date("2026-10-09T10:00:00Z");
    const inserted = await insertMediaSession({ id: "s1", channelId: "UC1", status: "pending", requestedBy: "factory", maxMinutes: 60, estimateUsd: 2, fitsToday: true, createdAt, minCudaVersion: "13.0" }, database);
    assert.deepEqual([inserted.minCudaVersion, inserted.usedMinCudaVersion, inserted.hostCudaVersion], ["13.0", null, null]);
    const approved = await transitionMediaSession("s1", ["pending"], { status: "approved", usedMinCudaVersion: "13.0" }, database);
    assert.equal(approved?.usedMinCudaVersion, "13.0");
    const starting = await transitionMediaSession("s1", ["approved"], { status: "starting", hostCudaVersion: "12.9" }, database);
    assert.equal(starting?.hostCudaVersion, "12.9");
    const back = await transitionMediaSession("s1", ["starting"], { status: "approved", hostCudaVersion: null }, database);
    assert.deepEqual([back?.minCudaVersion, back?.usedMinCudaVersion, back?.hostCudaVersion], ["13.0", "13.0", null]);
  }));

test("BL-159: each capacity-log row gets its own host's CUDA by id -- a later placement never overwrites an earlier one", () =>
  withDb(async (database) => {
    const at = new Date("2026-10-09T10:00:00Z");
    const base = { sessionId: "s1", datacenterId: "EU-RO-1", gpuTypeId: "NVIDIA GeForce RTX 4090", pricePerHr: 0.69, detail: null };
    const first = await insertMediaCapacityAttempt({ ...base, at, result: "placed" }, database);
    await insertMediaCapacityAttempt({ ...base, at: new Date(at.getTime() + 1000), result: "error", detail: "CUDA driver too old: host 12.4 < 12.8" }, database);
    const second = await insertMediaCapacityAttempt({ ...base, at: new Date(at.getTime() + 2000), result: "placed", hostCudaVersion: null }, database);
    assert.notEqual(first, second);
    await setMediaCapacityAttemptHostCuda(first, "12.4", database);
    await setMediaCapacityAttemptHostCuda(second, "12.8", database);
    const rows = await listMediaCapacityAttempts({ limit: 10 }, database);
    assert.deepEqual(
      rows.map((r) => [r.result, r.hostCudaVersion]),
      [
        ["placed", "12.8"],
        ["error", null],
        ["placed", "12.4"],
      ]
    );
  }));

test("BL-159: a factory template's minimum is stored, and a new version without one clears it", () =>
  withDb(async (database) => {
    const row = (version: number, minCudaVersion: string | null) => ({ id: "lm-codes", name: "LM", description: null, version, workflowJson: "{}", parametersJson: "[]", outputNodeIdsJson: "[]", nodeCount: 1, registrySha256: `sha-${version}`, modelsJson: "[]", gpuJson: null, minCudaVersion });
    assert.equal((await upsertFactoryMediaWorkflowTemplate(row(1, "13.0"), database))?.minCudaVersion, "13.0");
    assert.equal((await upsertFactoryMediaWorkflowTemplate(row(2, null), database))?.minCudaVersion, null);
  }));
