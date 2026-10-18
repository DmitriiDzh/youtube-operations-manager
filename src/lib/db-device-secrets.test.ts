import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deleteStoredDeviceSecret,
  getStoredDeviceSecret,
  initializeDatabaseSchema,
  isDeviceSecretMigrated,
  markDeviceSecretMigrated,
  SCHEMA_MIGRATIONS,
  setStoredDeviceSecretStatus,
  upsertStoredDeviceSecret,
  type AppDb,
} from "@/lib/db";

// BL-199 (ADR 0042) on a real migrated database: schema v96 creates `device_secrets`; a write grows the revision; the status
// compare-and-set touches only the expected revision; the "migrated" marker survives a delete of the row.

async function withDb(run: (database: AppDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-device-secrets-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (name: string, ciphertext: string) => ({ name, ciphertext, iv: "iv", authTag: "tag", hints: { keyHint: "abcd" }, status: "ok", verifiedAt: 100, updatedAt: 200 });

test("v96 creates device_secrets", () => {
  assert.ok(SCHEMA_MIGRATIONS.some((m) => m.version === 96));
});

test("device_secrets: upsert grows the revision; hints and times round-trip in ms", async () => {
  await withDb(async (database) => {
    await upsertStoredDeviceSecret(row("gemini", "c1"), database);
    const first = await getStoredDeviceSecret("gemini", database);
    assert.deepEqual(first && { revision: first.revision, hints: first.hints, verifiedAt: first.verifiedAt, updatedAt: first.updatedAt }, {
      revision: 1,
      hints: { keyHint: "abcd" },
      verifiedAt: 100,
      updatedAt: 200,
    });
    await upsertStoredDeviceSecret(row("gemini", "c2"), database);
    assert.equal((await getStoredDeviceSecret("gemini", database))?.revision, 2);
  });
});

test("device_secrets: status compare-and-set applies only on the expected ciphertext", async () => {
  await withDb(async (database) => {
    await upsertStoredDeviceSecret(row("gemini", "c1"), database);
    await upsertStoredDeviceSecret(row("gemini", "c2"), database);
    // Review of BL-199: the compare-and-set token is the ciphertext (unique per save), not the row counter.
    assert.equal(await setStoredDeviceSecretStatus("gemini", "c1", { status: "payment_required" }, database), false);
    assert.equal((await getStoredDeviceSecret("gemini", database))?.status, "ok");
    assert.equal(await setStoredDeviceSecretStatus("gemini", "c2", { status: "payment_required", verifiedAt: 300 }, database), true);
    const after = await getStoredDeviceSecret("gemini", database);
    assert.deepEqual([after?.status, after?.verifiedAt], ["payment_required", 300]);
  });
});

test("device_secrets: delete removes one row; the migrated marker is separate and stays", async () => {
  await withDb(async (database) => {
    await upsertStoredDeviceSecret(row("gemini", "c1"), database);
    await upsertStoredDeviceSecret(row("huggingface", "h1"), database);
    await markDeviceSecretMigrated("gemini", 1, database);
    await deleteStoredDeviceSecret("gemini", database);
    assert.equal(await getStoredDeviceSecret("gemini", database), null);
    assert.ok(await getStoredDeviceSecret("huggingface", database));
    assert.equal(await isDeviceSecretMigrated("gemini", database), true);
    assert.equal(await isDeviceSecretMigrated("runpod", database), false);
  });
});
