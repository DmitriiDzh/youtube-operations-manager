import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseInitialization, rawSqlClient } from "@/lib/db";
import { getOperationLock } from "@/lib/operation-lock";

// RISK-20 (docs/TECHNICAL_DEBT.md): boot-time schema migration now acquires the operation
// lock (type "migration") around itself. This cannot exercise the acquire/release wiring by
// calling `initializeDatabase` a second time (it runs once at module load, and re-triggering it
// would risk re-running migrations outside their real boot path) -- instead this asserts the
// one property whose absence would be a worse regression than not having the fix at all: the
// lock is never left held after boot completes. A leaked "migration" lock would permanently
// block every export/import/other-migration attempt on this device.
test("boot-time migration does not leave the operation lock held once initialization completes", async () => {
  await databaseInitialization;
  assert.equal(await getOperationLock(rawSqlClient), null);
});
