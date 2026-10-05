import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  approveMediaSessionGuarded,
  initializeDatabaseSchema,
  insertMediaSession,
  listOpenMediaSessions,
  releaseMediaVolumeLock,
  transitionMediaSession,
  tryAcquireMediaVolumeLock,
  type AppDb,
  type NewStoredMediaSession,
} from "@/lib/db";

// Phase 14 slice 6 (docs/roadmap/plans/PHASE_14_PLAN.md §5.2; owner, Telegram 2026-10-05, msgs 1549/1551/1553), written
// from the acceptance criteria before the services use them, on real libSQL with two connections to one file (the web
// server and the operator CLI are separate processes):
//   AC-P14-22 several sessions may be active up to the limit; the next approve is refused even when approves race.
//   AC-P14-23 no session approve while a pull/operator pod holds the volume exclusively, and no exclusive hold while any
//             session is active.

function pendingRow(id: string, createdAt: Date): NewStoredMediaSession {
  return { id, channelId: "UC1", status: "pending", requestedBy: "agent", maxMinutes: 60, estimateUsd: 0.6, fitsToday: true, createdAt };
}

async function withTwoConnections(run: (a: AppDb, b: AppDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-sessions-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const ca = createClient({ url });
  const cb = createClient({ url });
  try {
    await initializeDatabaseSchema(ca);
    await run(drizzle(ca) as unknown as AppDb, drizzle(cb) as unknown as AppDb);
  } finally {
    ca.close();
    cb.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("AC-P14-22: several requests can be pending at once (no request-time conflict any more); listOpen returns them oldest first", async () => {
  await withTwoConnections(async (a, b) => {
    const t0 = new Date("2026-10-05T12:00:00Z");
    await insertMediaSession(pendingRow("s1", t0), a);
    await insertMediaSession(pendingRow("s2", new Date(t0.getTime() + 1000)), b);
    await insertMediaSession(pendingRow("s3", new Date(t0.getTime() + 2000)), a);
    assert.deepEqual((await listOpenMediaSessions(b)).map((r) => r.id), ["s1", "s2", "s3"]);
  });
});

test("AC-P14-22: with a limit of 2, two approves pass and the third is refused; racing approves never exceed the limit", async () => {
  await withTwoConnections(async (a, b) => {
    const t0 = new Date("2026-10-05T12:00:00Z");
    for (const [i, id] of ["s1", "s2", "s3", "s4"].entries()) await insertMediaSession(pendingRow(id, new Date(t0.getTime() + i * 1000)), a);
    // Four approves from two connections at once, limit 2: exactly two win.
    const results = await Promise.all([
      approveMediaSessionGuarded("s1", { approvedAt: t0 }, 2, a),
      approveMediaSessionGuarded("s2", { approvedAt: t0 }, 2, b),
      approveMediaSessionGuarded("s3", { approvedAt: t0 }, 2, a),
      approveMediaSessionGuarded("s4", { approvedAt: t0 }, 2, b),
    ]);
    assert.equal(results.filter((r) => r !== null).length, 2);
    const statuses = (await listOpenMediaSessions(a)).map((r) => r.status).sort();
    assert.deepEqual(statuses, ["approved", "approved", "pending", "pending"]);
    // A slot frees when a session becomes terminal; then one more approve passes.
    const winner = results.find((r) => r !== null)!;
    await transitionMediaSession(winner.id, ["approved"], { status: "failed" }, a);
    const loser = results.findIndex((r) => r === null);
    const loserId = ["s1", "s2", "s3", "s4"][loser];
    assert.notEqual(await approveMediaSessionGuarded(loserId, { approvedAt: t0 }, 2, b), null);
    // A non-pending row is never approved again (a retried POST).
    assert.equal(await approveMediaSessionGuarded(loserId, { approvedAt: t0 }, 4, a), null);
  });
});

test("AC-P14-23: an approve is refused while a pull holds the volume; a pull's lock is refused while a session is active", async () => {
  await withTwoConnections(async (a, b) => {
    const t0 = new Date("2026-10-05T12:00:00Z");
    await insertMediaSession(pendingRow("s1", t0), a);
    const pull = await tryAcquireMediaVolumeLock("pull:p1", t0, b);
    assert.equal(pull.acquired, true);
    assert.equal(await approveMediaSessionGuarded("s1", { approvedAt: t0 }, 4, a), null);
    assert.equal((await listOpenMediaSessions(a))[0].status, "pending"); // nothing changed
    assert.equal(await releaseMediaVolumeLock("pull:p1", b), true);
    assert.notEqual(await approveMediaSessionGuarded("s1", { approvedAt: t0 }, 4, a), null);
    // The reverse: an active session blocks the exclusive hold; no lock row is written.
    assert.deepEqual(await tryAcquireMediaVolumeLock("pull:p2", t0, b), { acquired: false, holder: null, activeSessions: 1 });
    assert.deepEqual(await tryAcquireMediaVolumeLock("pod:operator", t0, b), { acquired: false, holder: null, activeSessions: 1 });
    // A terminal session no longer blocks.
    await transitionMediaSession("s1", ["approved"], { status: "done" }, a);
    assert.equal((await tryAcquireMediaVolumeLock("pull:p2", t0, b)).acquired, true);
  });
});
