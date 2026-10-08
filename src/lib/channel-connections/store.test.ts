import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, getRefreshTokenIssuedAt, initializeDatabaseSchema, refreshTokenIssuedAtPatch, users } from "@/lib/db";

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conn-health-store-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("migration v41 adds users.refresh_token_issued_at as a nullable column", () =>
  withDb(async (_db, client) => {
    const info = await client.execute("PRAGMA table_info(users)");
    const column = info.rows.find((r) => r.name === "refresh_token_issued_at");
    assert.ok(column, "column exists");
    assert.equal(column.notnull, 0, "nullable (existing rows stay NULL = unknown)");
  }));

test("getRefreshTokenIssuedAt: NULL for a pre-v41 style row, the stored date once set, NULL for an unknown user", () =>
  withDb(async (db) => {
    await db.insert(users).values({ id: "u1", email: "a@example.com" });
    assert.equal(await getRefreshTokenIssuedAt("u1", db), null);

    const issued = new Date("2026-10-03T10:00:00Z");
    await db.insert(users).values({ id: "u2", email: "b@example.com", refreshTokenIssuedAt: issued });
    assert.equal((await getRefreshTokenIssuedAt("u2", db))?.toISOString(), "2026-10-03T10:00:00.000Z");

    assert.equal(await getRefreshTokenIssuedAt("nobody", db), null);
  }));

test("refreshTokenIssuedAtPatch sets the date only when a refresh token was actually issued", () => {
  const now = new Date("2026-10-03T10:00:00Z");
  assert.deepEqual(refreshTokenIssuedAtPatch("a-refresh-token", now), { refreshTokenIssuedAt: now });
  assert.deepEqual(refreshTokenIssuedAtPatch(null, now), {}, "an access-token-only sign-in must not make an old grant look new");
  assert.deepEqual(refreshTokenIssuedAtPatch(undefined, now), {});
  assert.deepEqual(refreshTokenIssuedAtPatch("", now), {});
});
