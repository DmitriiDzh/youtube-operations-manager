import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  closeGenerationPlanRecheck,
  initializeDatabaseSchema,
  insertGenerationPlanPeerVerdict,
  insertGenerationPlanRecheck,
  insertGenerationPlanVerdictHistory,
  listGenerationPlanPeerVerdicts,
  listGenerationPlanRechecks,
  listGenerationPlanVerdictHistory,
  replaceGenerationPlanRecheckAnswer,
  SCHEMA_MIGRATIONS,
  type AppDb,
} from "@/lib/db";

// BL-173 (docs/roadmap/plans/PLAN_RECHECKS_PLAN.md §2.1, schema v82) on a real migrated database: one re-check per (plan, id),
// only an open one closes, and the history and peer-verdict rows keep `recheck_id` / `kept`. The migration converges when run
// again (each added column behind the duplicate-column guard).

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-plan-rechecks-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const recheck = (recheckId: string) => ({
  planId: "R-0001-S1-music",
  recheckId,
  itemKey: "C14/V04",
  attemptRef: "job:8c4a4827",
  kind: "revision" as const,
  title: "резкость",
  note: "fixed the 2-3 kHz band",
  auditionFile: "R-0001-S1-music/C14/C14-XL_V04_s1811__r1.mp3",
  markersJson: null,
  checksJson: null,
  metricsJson: JSON.stringify({ lufs: -16.2 }),
  previousVerdictJson: JSON.stringify({ result: "rejected" }),
  status: "open" as const,
  openedAt: new Date("2026-10-10T12:00:00.123Z"),
  closedAt: null,
  answerJson: null,
  withdrawNote: null,
  closeReason: null,
});

test("schema v82: a second run of the migration converges (the four added columns are guarded)", () =>
  withDb(async (_database, client) => {
    const v82 = SCHEMA_MIGRATIONS.find((m) => m.version === 82);
    assert.ok(v82);
    await v82.apply(client);
    const columns = async (table: string) => (await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name));
    for (const table of ["generation_plan_verdict_history", "generation_plan_peer_verdicts"]) {
      const names = await columns(table);
      assert.ok(names.includes("recheck_id") && names.includes("kept"), table);
    }
    assert.ok((await columns("generation_plan_rechecks")).includes("previous_verdict_json"));
  }));

test("re-checks: one per (plan, id); listed oldest first; only an open one closes, once", () =>
  withDb(async (database) => {
    assert.equal(await insertGenerationPlanRecheck(recheck("r1"), database), true);
    assert.equal(await insertGenerationPlanRecheck({ ...recheck("r1"), title: "другое" }, database), false, "the same id is not stored twice");
    assert.equal(await insertGenerationPlanRecheck({ ...recheck("q1"), kind: "question", auditionFile: null, openedAt: new Date("2026-10-10T12:05:00Z") }, database), true);
    const listed = await listGenerationPlanRechecks("R-0001-S1-music", database);
    assert.deepEqual(listed.map((r) => [r.recheckId, r.title, r.status]), [["r1", "резкость", "open"], ["q1", "резкость", "open"]]);
    assert.equal(listed[0].openedAt.toISOString(), "2026-10-10T12:00:00.123Z", "milliseconds kept");
    const closedAt = new Date("2026-10-10T12:10:00Z");
    assert.equal(await closeGenerationPlanRecheck("R-0001-S1-music", "r1", { status: "answered", closedAt, answerJson: JSON.stringify({ result: "accepted" }), withdrawNote: null, closeReason: null }, database), true);
    assert.equal(await closeGenerationPlanRecheck("R-0001-S1-music", "r1", { status: "withdrawn", closedAt, answerJson: null, withdrawNote: "late", closeReason: null }, database), false, "not open any more");
    const r1 = (await listGenerationPlanRechecks("R-0001-S1-music", database))[0];
    assert.deepEqual([r1.status, r1.answerJson, r1.withdrawNote], ["answered", JSON.stringify({ result: "accepted" }), null]);
    // Review round 1: a newer verdict answer replaces an ANSWERED re-check's answer; an open one is never answered this way.
    assert.equal(await replaceGenerationPlanRecheckAnswer("R-0001-S1-music", "r1", JSON.stringify({ result: "rejected" }), database), true);
    assert.equal((await listGenerationPlanRechecks("R-0001-S1-music", database))[0].answerJson, JSON.stringify({ result: "rejected" }));
    assert.equal(await replaceGenerationPlanRecheckAnswer("R-0001-S1-music", "q1", JSON.stringify({ result: "rejected" }), database), false);
    assert.equal((await listGenerationPlanRechecks("R-0001-S1-music", database))[1].answerJson, null);
    assert.deepEqual(await listGenerationPlanRechecks("other-plan", database), []);
  }));

test("history and peer verdicts keep the re-check id and the kept flag", () =>
  withDb(async (database) => {
    const base = { planId: "R-0001-S1-music", itemKey: "C14/V03", attemptRef: "job:22b11bf2", result: "accepted", rating: null, reasonsJson: null, markersJson: null, note: "no voice heard", device: "MAC", recordedAt: new Date() };
    await insertGenerationPlanVerdictHistory({ ...base, rating: 8, note: null, at: "2026-10-10T12:00:00.000Z" }, database);
    await insertGenerationPlanVerdictHistory({ ...base, at: "2026-10-10T12:30:00.000Z", recheckId: "q1", kept: 1 }, database);
    assert.deepEqual(
      (await listGenerationPlanVerdictHistory("R-0001-S1-music", database)).map((h) => [h.rating, h.recheckId, h.kept]),
      [
        [8, null, null],
        [null, "q1", 1],
      ]
    );
    await insertGenerationPlanPeerVerdict({ verdictId: "win-1-id-0001", planId: "R-0001-S1-music", ownerDeviceId: "mac-1", itemKey: "C14/V03", attemptRef: "job:22b11bf2", result: "accepted", note: null, at: "2026-10-10T12:31:00.000Z", recheckId: "q1", kept: 1 }, database);
    const [peer] = await listGenerationPlanPeerVerdicts("2026-10-01T00:00:00.000Z", database);
    assert.deepEqual([peer.recheckId, peer.kept], ["q1", 1]);
  }));
