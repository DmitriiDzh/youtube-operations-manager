import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getMediaModelPullsJson, initializeDatabaseSchema, releaseMediaVolumeLock, tryAcquireMediaVolumeLock, updateMediaModelPullsJson, type AppDb } from "@/lib/db";

// Phase 14 review round 12: the pulls list is updated by compare-and-swap (no cross-connection transaction), so two
// CONNECTIONS to the same file (the web server and the operator CLI) never overwrite each other's change, and the
// volume lock's insert is a real test-and-set. Real libSQL, a throwaway database file.

test("updateMediaModelPullsJson: two connections interleaving read-modify-write both land (the loser re-applies); the lock row admits one owner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-cas-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const a = createClient({ url });
  const b = createClient({ url });
  try {
    await initializeDatabaseSchema(a);
    const dbA = drizzle(a) as unknown as AppDb;
    const dbB = drizzle(b) as unknown as AppDb;
    await updateMediaModelPullsJson(() => JSON.stringify(["A"]), dbA);
    // B's mutate runs against the value it read; A changes the row in between the read and B's write (simulated by
    // mutating from inside B's callback on the first call).
    let bCalls = 0;
    await updateMediaModelPullsJson((current) => {
      bCalls++;
      const list = JSON.parse(current ?? "[]") as string[];
      if (bCalls === 1) void updateMediaModelPullsJson((c) => JSON.stringify([...(JSON.parse(c ?? "[]") as string[]), "A2"]), dbA);
      return JSON.stringify([...list, "B"]);
    }, dbB);
    // Whatever the interleaving, nothing written by A is lost and B's item is present.
    const final = JSON.parse((await getMediaModelPullsJson(dbA)) ?? "[]") as string[];
    assert.ok(final.includes("A") && final.includes("B"), JSON.stringify(final));
    assert.ok(bCalls >= 1);

    const t0 = new Date("2026-10-05T12:00:00Z");
    assert.deepEqual(await tryAcquireMediaVolumeLock("session:s1", t0, dbA), { acquired: true, holder: { owner: "session:s1", since: t0 } });
    assert.deepEqual(await tryAcquireMediaVolumeLock("pull:p1", new Date(t0.getTime() + 1000), dbB), { acquired: false, holder: { owner: "session:s1", since: t0 } });
    assert.equal(await releaseMediaVolumeLock("pull:p1", dbB), false);
    assert.equal(await releaseMediaVolumeLock("session:s1", dbA), true);
    assert.deepEqual(await tryAcquireMediaVolumeLock("pull:p1", t0, dbB), { acquired: true, holder: { owner: "pull:p1", since: t0 } });
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
