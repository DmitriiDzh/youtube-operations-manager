import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, deleteSocialAccounts, getSocialPostJob, initializeDatabaseSchema, insertSocialPostJob, listSocialAccounts, markSocialPostJobOwnerRetry, SCHEMA_MIGRATIONS, updateSocialPostJob, upsertSocialAccount } from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";

// BL-252 (ADR 0068): schema v121 adds `social_accounts` -- one row per (channel, network); a second connect replaces the row.
// Device-local: the token is sealed with this computer's key, so the table never travels in a snapshot.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-social-accounts-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (over: Partial<Parameters<typeof upsertSocialAccount>[0]> = {}) => ({
  channelId: "UC1",
  network: "facebook" as const,
  externalId: "111",
  displayName: "WWE",
  username: null,
  pageId: "111",
  tokenSealed: '{"ciphertext":"x","iv":"y","authTag":"z"}',
  tokenExpiresAt: null,
  connectedAt: new Date("2026-11-14T10:00:00Z"),
  ...over,
});

test("schema v121 exists, creates social_accounts, and the table is device-local", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 121));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.social_accounts);
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_accounts'");
    assert.equal(t.rows.length, 1);
  });
});

test("one row per (channel, network): a second connect replaces it; delete by network or the whole channel", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await upsertSocialAccount(row(), database);
    await upsertSocialAccount(row({ externalId: "222", displayName: "Other", pageId: "222" }), database);
    await upsertSocialAccount(row({ network: "instagram", externalId: "1784", username: "wwexplained" }), database);
    await upsertSocialAccount(row({ channelId: "UC2" }), database);
    const uc1 = await listSocialAccounts("UC1", database);
    assert.deepEqual(uc1.map((r) => [r.network, r.externalId, r.displayName]), [["facebook", "222", "Other"], ["instagram", "1784", "WWE"]]);
    assert.equal((await listSocialAccounts(null, database)).length, 3);
    assert.equal(await deleteSocialAccounts("UC1", "instagram", database), 1);
    assert.equal(await deleteSocialAccounts("UC1", null, database), 1);
    assert.deepEqual((await listSocialAccounts(null, database)).map((r) => r.channelId), ["UC2"]);
  });
});

test("schema v122 social_post_jobs: a job id is inserted once (a second start is refused), updates keep the row; device-local", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 122));
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.social_post_jobs);
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const at = new Date("2026-11-16T15:00:00Z");
    const job = { jobId: "UC1|s1|instagram", channelId: "UC1", slotId: "s1", video: "V70", network: "instagram" as const, manifestSha256: "m", plannedAt: at, status: "uploading" as const, createdAt: at, updatedAt: at };
    assert.equal(await insertSocialPostJob(job, database), true);
    assert.equal(await insertSocialPostJob({ ...job, video: "V71" }, database), false);
    await updateSocialPostJob(job.jobId, { status: "processing", remoteId: "C1" }, database);
    const row = await getSocialPostJob(job.jobId, database);
    assert.equal(row?.video, "V70");
    assert.equal(row?.status, "processing");
    assert.equal(row?.remoteId, "C1");
  });
});

test("schema v123 social_post_jobs.owner_retry_at: null by default, the owner's retry time kept and cleared (owner TG 4780)", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 123));
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const at = new Date("2026-11-20T12:00:00Z");
    const job = { jobId: "UC1|s6|facebook", channelId: "UC1", slotId: "s6", video: "S6", network: "facebook" as const, manifestSha256: "m", plannedAt: at, status: "failed" as const, createdAt: at, updatedAt: at };
    assert.equal(await insertSocialPostJob(job, database), true);
    assert.equal((await getSocialPostJob(job.jobId, database))?.ownerRetryAt, null);
    const retry = new Date("2026-11-23T10:00:00Z");
    await updateSocialPostJob(job.jobId, { ownerRetryAt: retry }, database);
    assert.equal((await getSocialPostJob(job.jobId, database))?.ownerRetryAt?.getTime(), retry.getTime());
    await updateSocialPostJob(job.jobId, { ownerRetryAt: null }, database);
    assert.equal((await getSocialPostJob(job.jobId, database))?.ownerRetryAt, null);
  });
});

// Review 23.11 (owner TG 4780: never a retry of a job whose publish call was sent): the owner's retry mark is one conditional update --
// only a `failed` job with publish_attempted = 0 and no remote post id is marked; any other row is left untouched (false).
test("markSocialPostJobOwnerRetry: marks only failed + never attempted + no post id; otherwise false and the row unchanged", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    const at = new Date("2026-11-20T12:00:00Z");
    const retry = new Date("2026-11-23T10:00:00Z");
    type Status = "failed" | "uploading" | "processing" | "published";
    const base = { channelId: "UC1", slotId: "s6", video: "S6", network: "facebook" as const, manifestSha256: "m", plannedAt: at, status: "failed" as Status, createdAt: at, updatedAt: at };
    const cases: Array<[string, { publishAttempted?: boolean; remotePostId?: string | null; status?: Status }, boolean]> = [
      ["failed, never attempted", {}, true],
      ["publish call sent", { publishAttempted: true }, false],
      ["has a post id", { remotePostId: "V9" }, false],
      ["taken over (uploading)", { status: "uploading" }, false],
      ["processing", { status: "processing" }, false],
      ["published", { status: "published", remotePostId: "V9" }, false],
    ];
    for (const [i, [name, over, expected]] of cases.entries()) {
      const jobId = `UC1|s${i}|facebook`;
      assert.equal(await insertSocialPostJob({ ...base, ...over, jobId }, database), true, name);
      assert.equal(await markSocialPostJobOwnerRetry(jobId, retry, database), expected, name);
      assert.equal((await getSocialPostJob(jobId, database))?.ownerRetryAt?.getTime() ?? null, expected ? retry.getTime() : null, name);
    }
    assert.equal(await markSocialPostJobOwnerRetry("UC1|missing|facebook", retry, database), false);
  });
});
