import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  getAnalyticsEveningAttempt,
  getAnalyticsEveningLocalTime,
  initializeDatabaseSchema,
  recordAnalyticsEveningAttempt,
  setAnalyticsEveningLocalTime,
} from "@/lib/db";

// BL-181 (FO-REQ-0020 §2.3): the evening boundary starts at 22:05 on a fresh install, "" turns it off and stays off; the last
// evening attempt is kept per channel on this computer.

test("evening boundary: 22:05 until set, '' stays off; attempts are per channel and replace the older one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evening-store-test-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const db = createIsolatedDb(client);
    assert.equal(await getAnalyticsEveningLocalTime(db), "22:05");
    await setAnalyticsEveningLocalTime("", db);
    assert.equal(await getAnalyticsEveningLocalTime(db), "");
    await setAnalyticsEveningLocalTime("21:30", db);
    assert.equal(await getAnalyticsEveningLocalTime(db), "21:30");

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
