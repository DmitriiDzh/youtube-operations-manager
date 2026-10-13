import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  getAnalyticsEveningAttempt,
  getAnalyticsCollectionTimes,
  initializeDatabaseSchema,
  recordAnalyticsEveningAttempt,
  setAnalyticsCollectionTimes,
  setUserTimezone,
} from "@/lib/db";

// BL-181 (FO-REQ-0020 §2.3): the evening boundary starts at 22:05 local on a fresh install -- 19:05 UTC for the owner's Helsinki on
// 2026-10-13, since the times are UTC (owner, msgs 2725/2727) -- "" turns it off and stays off; the last evening attempt is kept
// per channel on this computer.

test("evening boundary: 22:05 Helsinki (19:05 UTC) until set, '' stays off; attempts are per channel and replace the older one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evening-store-test-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const db = createIsolatedDb(client);
    await setUserTimezone("Europe/Helsinki", db);
    assert.equal((await getAnalyticsCollectionTimes(db)).eveningUtc, "19:05");
    await setAnalyticsCollectionTimes({ eveningUtc: "" }, db);
    assert.equal((await getAnalyticsCollectionTimes(db)).eveningUtc, "");
    await setAnalyticsCollectionTimes({ eveningUtc: "18:30" }, db);
    assert.equal((await getAnalyticsCollectionTimes(db)).eveningUtc, "18:30");

    assert.equal(await getAnalyticsEveningAttempt("UC_A", db), null);
    await recordAnalyticsEveningAttempt("UC_A", new Date("2026-10-13T19:10:00Z"), db);
    await recordAnalyticsEveningAttempt("UC_B", new Date("2026-10-13T19:11:00Z"), db);
    await recordAnalyticsEveningAttempt("UC_A", new Date("2026-10-14T19:10:00Z"), db);
    assert.equal((await getAnalyticsEveningAttempt("UC_A", db))?.toISOString(), "2026-10-14T19:10:00.000Z");
    assert.equal((await getAnalyticsEveningAttempt("UC_B", db))?.toISOString(), "2026-10-13T19:11:00.000Z");
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
