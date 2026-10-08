import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { countMediaJobsForSessionByStatus, getMediaSessionJobSummary, initializeDatabaseSchema, insertMediaJob, listOpenMediaJobsForSession, type AppDb } from "@/lib/db";

// BL-148 (CROSS_DEVICE_JOB_PROGRESS_PLAN.md, AC-XJ-01/06; independent review): a plan run creates all its jobs at once, so the
// job that is actually running is often the OLDEST. What another device is shown must be counted over all of the session's jobs
// and must list the running job first, however many jobs follow it. Real libSQL, a throwaway database file.

test("a session's counts cover all its jobs and the running job is listed first even behind 300 newer jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-jobs-share-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const base = Date.parse("2026-10-07T10:00:00Z");
    const add = (id: string, sessionId: string, status: "queued" | "generating" | "done" | "failed", minute: number) =>
      insertMediaJob({ id, sessionId, channelId: "UC1", templateId: "ace", templateVersion: 1, paramsJson: "{}", status, createdBy: "factory", createdAt: new Date(base + minute * 60_000) }, database);
    for (let i = 0; i < 10; i++) await add(`done-${i}`, "s1", "done", i);
    await add("failed-0", "s1", "failed", 10);
    await add("running", "s1", "generating", 11);
    for (let i = 0; i < 300; i++) await add(`queued-${String(i).padStart(3, "0")}`, "s1", "queued", 12 + i);
    await add("other-session", "s2", "generating", 0);
    // Created in the same second: the insertion order decides (re-review).
    await add("tie-b", "s3", "queued", 5);
    await add("tie-a", "s3", "queued", 5);

    assert.deepEqual(await countMediaJobsForSessionByStatus("s1", database), { done: 10, failed: 1, generating: 1, queued: 300 });
    const open = await listOpenMediaJobsForSession("s1", 5, database);
    assert.deepEqual(open.map((j) => j.id), ["running", "queued-000", "queued-001", "queued-002", "queued-003"]);
    assert.deepEqual((await listOpenMediaJobsForSession("s3", 5, database)).map((j) => j.id), ["tie-b", "tie-a"]);
    assert.deepEqual(await countMediaJobsForSessionByStatus("unknown", database), {});
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// BL-155 (CUDA_HOSTS_PLAN.md AC-CU-03): release-when-done needs to know whether EVERY job of the session failed.
test("AC-CU-03: the session job summary counts failed jobs next to the total and the open ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-jobs-summary-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const add = (id: string, sessionId: string, status: "queued" | "done" | "failed" | "cancelled", finishedAt: Date | null) =>
      insertMediaJob({ id, sessionId, channelId: "UC1", templateId: "ace", templateVersion: 1, paramsJson: "{}", status, createdBy: "factory", createdAt: new Date("2026-10-07T10:00:00Z"), finishedAt }, database);
    await add("a1", "all-failed", "failed", new Date("2026-10-07T10:01:00Z"));
    await add("a2", "all-failed", "failed", new Date("2026-10-07T10:02:00Z"));
    await add("m1", "mixed", "failed", new Date("2026-10-07T10:01:00Z"));
    await add("m2", "mixed", "done", new Date("2026-10-07T10:03:00Z"));
    await add("m3", "mixed", "cancelled", null);
    await add("m4", "mixed", "queued", null);
    assert.deepEqual(await getMediaSessionJobSummary("all-failed", database), { total: 2, open: 0, failed: 2, lastFinishedAt: new Date("2026-10-07T10:02:00Z") });
    assert.deepEqual(await getMediaSessionJobSummary("mixed", database), { total: 4, open: 1, failed: 1, lastFinishedAt: new Date("2026-10-07T10:03:00Z") });
    assert.deepEqual(await getMediaSessionJobSummary("none", database), { total: 0, open: 0, failed: 0, lastFinishedAt: null });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
