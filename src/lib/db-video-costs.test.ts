import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import { countUnlinkedJobsByOrigin, getMediaJobById, initializeDatabaseSchema, insertGeminiMediaJob, insertMediaJob, insertMediaSession, linkUnlinkedJobsToVideo, listMediaSessionsNeedingCostSplit, recordMediaJobTiming, setMediaJobCostShare, type AppDb } from "@/lib/db";

// BL-194 stage 2 (VIDEO_COST_PLAN.md §2 stage 2, ADR 0041) on real libSQL, a throwaway database file: a job keeps the FIRST GPU
// start and finish ComfyUI reported, and an ended session is listed for the split until each of its jobs carries a share computed
// from the session's current charge.

async function withDb(fn: (database: AppDb) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-video-costs-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(drizzle(client) as unknown as AppDb);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const session = (id: string, status: "running" | "done", usdCharged: number | null) => ({
  id,
  channelId: "UC1",
  status,
  requestedBy: "factory" as const,
  maxMinutes: 60,
  estimateUsd: 1,
  fitsToday: true,
  costPerHr: 3.6,
  usdCharged,
});
const job = (id: string, sessionId: string) => ({ id, sessionId, channelId: "UC1", templateId: "t", templateVersion: 1, paramsJson: "{}", status: "done" as const, createdBy: "factory" as const, createdAt: new Date("2026-10-17T10:00:00Z") });

test("BL-194: a job's GPU start and finish keep the first time recorded; a later event never moves them", async () => {
  await withDb(async (database) => {
    await insertMediaJob(job("j1", "s1"), database);
    await recordMediaJobTiming("j1", { startedAt: new Date("2026-10-17T10:00:05.250Z") }, database);
    await recordMediaJobTiming("j1", { startedAt: new Date("2026-10-17T10:09:00Z"), gpuFinishedAt: new Date("2026-10-17T10:01:05.500Z") }, database);
    await recordMediaJobTiming("j1", { gpuFinishedAt: new Date("2026-10-17T10:09:00Z") }, database);
    const row = await getMediaJobById("j1", database);
    assert.equal(row?.startedAt?.toISOString(), "2026-10-17T10:00:05.250Z", "milliseconds kept");
    assert.equal(row?.gpuFinishedAt?.toISOString(), "2026-10-17T10:01:05.500Z");
  });
});

test("BL-194: an ended session is listed for the split until every job has a share of its current charge; a running one never", async () => {
  await withDb(async (database) => {
    await insertMediaSession(session("ended", "done", 1), database);
    await insertMediaSession(session("running", "running", null), database);
    await insertMediaJob(job("a", "ended"), database);
    await insertMediaJob(job("b", "ended"), database);
    await insertMediaJob(job("r", "running"), database);
    const first = await listMediaSessionsNeedingCostSplit(200, database);
    assert.deepEqual(first.map((p) => [p.session.id, p.jobs.map((j) => j.id).sort()]), [["ended", ["a", "b"]]]);

    await setMediaJobCostShare("a", { gpuSeconds: 60, allocatedUsd: 0.6667, overheadUsd: 0.6067, allocationBasis: "measured", allocationSessionUsd: 1 }, database);
    assert.equal((await listMediaSessionsNeedingCostSplit(200, database)).length, 1, "b has no share yet");
    await setMediaJobCostShare("b", { gpuSeconds: 30, allocatedUsd: 0.3333, overheadUsd: 0.3033, allocationBasis: "measured", allocationSessionUsd: 1 }, database);
    assert.deepEqual(await listMediaSessionsNeedingCostSplit(200, database), []);

    // A later correction of the session's charge (a pod found billing after the session ended) asks for a new split.
    await database.$client.execute("UPDATE media_sessions SET usd_charged = 1.25 WHERE id = 'ended'");
    assert.deepEqual((await listMediaSessionsNeedingCostSplit(200, database)).map((p) => p.session.id), ["ended"]);
  });
});

// BL-194 stage 4 (criterion 7): runs not linked to a video are counted per storyboard and per plan, and only those are linked when the
// owner confirms -- a job already linked to another video, or of another channel, is never moved.
test("BL-194: older runs are counted per storyboard and plan, and linking moves only this channel's unlinked jobs", async () => {
  await withDb(async (database) => {
    const add = (id: string, over: Record<string, unknown>) => insertMediaJob({ ...job(id, "s1"), ...over }, database);
    await add("sb-1", { storyboardId: "sb_bar" });
    await add("sb-2", { storyboardId: "sb_bar", video: "V12" });
    await add("plan-1", { planId: "plan-1" });
    await add("other", { storyboardId: "sb_bar", channelId: "UC2" });
    const at = new Date("2026-10-17T10:00:00Z");
    await insertGeminiMediaJob({ jobId: "g1", channelId: "UC1", requestHash: "h", kind: "video", model: "m", prompt: "p", paramsJson: "{}", inputsJson: "[]", status: "done", estimateUsd: 0.5, attempts: 1, createdBy: "factory", createdAt: at, updatedAt: at, storyboardId: "sb_bar" }, database);
    assert.deepEqual(
      (await countUnlinkedJobsByOrigin("UC1", database)).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { kind: "plan", id: "plan-1", runs: 1 },
        { kind: "storyboard", id: "sb_bar", runs: 2 },
      ]
    );
    assert.equal(await linkUnlinkedJobsToVideo("UC1", { storyboardId: "sb_bar" }, "V39", database), 2);
    assert.equal((await getMediaJobById("sb-1", database))?.video, "V39");
    assert.equal((await getMediaJobById("sb-2", database))?.video, "V12", "a job linked to another video stays");
    assert.equal((await getMediaJobById("other", database))?.video, null, "another channel's job stays");
    assert.equal(await linkUnlinkedJobsToVideo("UC1", { planId: "plan-1" }, "V40", database), 1);
    assert.deepEqual(await countUnlinkedJobsByOrigin("UC1", database), []);
  });
});

// Independent review (2026-10-17): an ended session with a job still running is not listed (it cannot be split yet), so a batch of
// such sessions can never hold the others back; the order is deterministic.
test("BL-194: sessions with a job still running are left out of the split list, which is ordered by session id", async () => {
  await withDb(async (database) => {
    for (let i = 0; i < 3; i++) {
      await insertMediaSession(session(`stuck-${i}`, "done", 1), database);
      await insertMediaJob({ ...job(`open-${i}`, `stuck-${i}`), status: "generating" }, database);
    }
    await insertMediaSession(session("ready-b", "done", 1), database);
    await insertMediaJob(job("b1", "ready-b"), database);
    await insertMediaSession(session("ready-a", "done", 1), database);
    await insertMediaJob(job("a1", "ready-a"), database);
    assert.deepEqual((await listMediaSessionsNeedingCostSplit(2, database)).map((p) => p.session.id), ["ready-a", "ready-b"]);
  });
});
