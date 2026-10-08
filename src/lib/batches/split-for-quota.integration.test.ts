// BL-117 slice 2, AC-G7: splitting a never-executed live batch for quota is ONE transaction against real SQLite: afterwards
// every original video is in exactly one new batch (none lost, none doubled) and the original can never be executed or resent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  channels,
  claimBatchExecution,
  createBatchWithLedger,
  createIsolatedDb,
  getStoredBatch,
  initializeDatabaseSchema,
  listStoredBatchesByChannel,
  listStoredLedgerRowsByBatch,
  splitPendingBatchForQuota,
  transitionLedgerRowStatus,
  type AppDb,
} from "@/lib/db";

let tempDir: string;
let client: Client;
let db: AppDb;
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batch-split-quota-"));
  client = createLibsqlClient({ url: `file:${path.join(tempDir, "test.db")}` });
  await initializeDatabaseSchema(client);
  db = createIsolatedDb(client);
  await db.insert(channels).values({ id: "UC_SPLIT", title: "T", uploadsPlaylistId: "UU_SPLIT" });
});

after(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

async function newBatch(videoIds: string[], over: { dryRun?: boolean; concurrency?: number } = {}) {
  const id = nextId("orig");
  await createBatchWithLedger(
    {
      id,
      channelId: "UC_SPLIT",
      concurrency: over.concurrency ?? 3,
      dryRun: over.dryRun ?? false,
      ledgerRows: videoIds.map((videoId) => ({ id: nextId("row"), videoId, changeIds: [`chg-${videoId}`] })),
    },
    db
  );
  return id;
}

const split = (batchId: string, fitCount: number, withFits = true, withRest = true) =>
  splitPendingBatchForQuota(
    { batchId, fitCount, fitsBatchId: withFits ? nextId("fits") : null, restBatchId: withRest ? nextId("rest") : null, newRowIds: () => nextId("nrow") },
    db
  );

test("a split moves every original video into exactly one new batch, in order, and closes the original completely", async () => {
  const videos = ["v1", "v2", "v3", "v4", "v5"];
  const original = await newBatch(videos, { concurrency: 4 });
  const result = await split(original, 2);
  assert.ok(result);
  assert.equal(result.fitRows, 2);
  assert.equal(result.restRows, 3);

  const fits = await listStoredLedgerRowsByBatch(result.fitsBatchId!, db);
  const rest = await listStoredLedgerRowsByBatch(result.restBatchId!, db);
  const originalRows = await listStoredLedgerRowsByBatch(original, db);

  assert.deepEqual(fits.map((r) => r.videoId).sort(), ["v1", "v2"], "the FIRST two rows in stored (insertion) order go to the batch that fits");
  assert.deepEqual(rest.map((r) => r.videoId).sort(), ["v3", "v4", "v5"]);
  const all = [...fits, ...rest].map((r) => r.videoId);
  assert.deepEqual([...all].sort(), [...videos].sort(), "no video lost");
  assert.equal(new Set(all).size, videos.length, "no video doubled");

  for (const row of [...fits, ...rest]) assert.equal(row.status, "PENDING");
  assert.deepEqual(fits.map((r) => r.changeIds ?? null).length, 2);

  const fitsBatch = await getStoredBatch(result.fitsBatchId!, db);
  const restBatch = await getStoredBatch(result.restBatchId!, db);
  for (const b of [fitsBatch, restBatch]) {
    assert.equal(b?.status, "PENDING");
    assert.equal(b?.dryRun, false);
    assert.equal(b?.concurrency, 4);
    assert.equal(b?.channelId, "UC_SPLIT");
  }

  const closed = await getStoredBatch(original, db);
  assert.equal(closed?.status, "ABORTED");
  assert.deepEqual(closed?.splitInto, [result.fitsBatchId, result.restBatchId]);
  assert.ok(originalRows.every((r) => r.status === "CANCELLED"), "the original can never write anything");
});

test("the new rows keep the original change ids, so the safety pipeline still re-checks exactly the same approved changes", async () => {
  const original = await newBatch(["a", "b"]);
  const result = await split(original, 1);
  assert.ok(result);
  const fitRow = (await listStoredLedgerRowsByBatch(result.fitsBatchId!, db))[0];
  assert.deepEqual(fitRow.changeIds, [`chg-${fitRow.videoId}`]);
});

test("fitCount 0 creates only the 'rest' batch; fitCount >= rows creates only the 'fits' batch", async () => {
  const a = await newBatch(["x1", "x2"]);
  const onlyRest = await split(a, 0, false, true);
  assert.ok(onlyRest);
  assert.equal(onlyRest.fitsBatchId, null);
  assert.equal(onlyRest.restRows, 2);

  const b = await newBatch(["y1", "y2"]);
  const onlyFits = await split(b, 99, true, false);
  assert.ok(onlyFits);
  assert.equal(onlyFits.restBatchId, null);
  assert.equal(onlyFits.fitRows, 2);
});

test("a batch that was started (RUNNING), is a dry run, has a row that already moved, or was already split is NOT split and nothing changes", async () => {
  const before = (await listStoredBatchesByChannel("UC_SPLIT", db)).length;

  const running = await newBatch(["r1", "r2"]);
  assert.equal(await claimBatchExecution(running, "run-1", db), true);
  assert.equal(await split(running, 1), null);

  const dry = await newBatch(["d1", "d2"], { dryRun: true });
  assert.equal(await split(dry, 1), null);

  const moved = await newBatch(["m1", "m2"]);
  const movedRows = await listStoredLedgerRowsByBatch(moved, db);
  assert.equal(await transitionLedgerRowStatus({ ledgerRowId: movedRows[0].id, from: ["PENDING"], to: "AWAITING_EXECUTION" }, db), true);
  assert.equal(await split(moved, 1), null);

  const once = await newBatch(["o1", "o2"]);
  assert.ok(await split(once, 1));
  assert.equal(await split(once, 1), null, "a closed original cannot be split again");

  const after = (await listStoredBatchesByChannel("UC_SPLIT", db)).length;
  // four originals created in this test + the two children of the one successful split; the refused ones created nothing
  assert.equal(after - before, 4 + 2);
  // the refused ones left their rows untouched
  assert.ok((await listStoredLedgerRowsByBatch(dry, db)).every((r) => r.status === "PENDING" || r.status === "DRY_RUN_COMPLETE"));
  assert.equal((await getStoredBatch(running, db))?.status, "RUNNING");
  assert.equal((await getStoredBatch(moved, db))?.status, "PENDING");
});

test("a part that needs a batch id but got none refuses the whole split (nothing is half-created)", async () => {
  const original = await newBatch(["z1", "z2", "z3"]);
  const before = (await listStoredBatchesByChannel("UC_SPLIT", db)).length;
  assert.equal(await split(original, 1, true, false), null, "a rest part exists but no id was given for it");
  assert.equal((await listStoredBatchesByChannel("UC_SPLIT", db)).length, before);
  assert.equal((await getStoredBatch(original, db))?.status, "PENDING");
});
