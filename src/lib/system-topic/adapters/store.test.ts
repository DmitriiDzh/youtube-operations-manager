import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, SCHEMA_MIGRATIONS } from "@/lib/db";
import type { SystemRequestRow } from "../approvals";
import { createSystemRequestStore, systemRequestFiles } from "./requests";
import { createSystemTopicStore } from "./store";

// BL-228 (schema v111) on a real migrated temporary database and a temporary folder: the migration converges when run again; a
// fresh database reads as "nothing set, off"; an update id is claimed once; the outbox hands a message out once; a request moves
// only from the state it is in (compare-and-set); the result file is written by rename and nothing outside the folder is reachable.

async function withDb(fn: (client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-topic-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("v111: the four tables exist and the migration converges when run again", () =>
  withDb(async (client) => {
    await SCHEMA_MIGRATIONS.find((m) => m.version === 111)!.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    for (const table of ["system_topic_state", "system_topic_commands", "system_topic_outbox", "system_topic_requests"]) assert.ok(names.includes(table), table);
  }));

test("a fresh database: nothing set, off, no relay secret, nothing dropped", () =>
  withDb(async (client) => {
    assert.deepEqual(await createSystemTopicStore(client).read(), {
      ownerUserId: null, chatId: null, threadId: null, enabled: false, requestsPath: null, relaySecretHash: null, relaySecretCreatedAt: null,
      droppedCount: 0, lastInboundAt: null, lastOutboxAt: null, lastScanAt: null, lastScanError: null, updatedAt: null,
    });
  }));

test("settings, the secret's hash and the counters are kept apart", () =>
  withDb(async (client) => {
    const store = createSystemTopicStore(client);
    await store.recordInbound({ dropped: 2, at: 1000 });
    await store.saveSettings({ ownerUserId: "331110302", chatId: "-1001234567890", threadId: "42", enabled: true, requestsPath: "/x/requests" }, 2000);
    await store.setRelaySecretHash("ab".repeat(32), 2500);
    await store.recordInbound({ dropped: 3, at: 3000 });
    await store.recordScan({ at: 3500, error: "boom" });
    const state = await store.read();
    assert.deepEqual(
      { ...state },
      { ownerUserId: "331110302", chatId: "-1001234567890", threadId: "42", enabled: true, requestsPath: "/x/requests", relaySecretHash: "ab".repeat(32), relaySecretCreatedAt: 2500, droppedCount: 5, lastInboundAt: 3000, lastOutboxAt: null, lastScanAt: 3500, lastScanError: "boom", updatedAt: 2000 }
    );
  }));

test("an update id is claimed once; the outbox hands each message out once, oldest first", () =>
  withDb(async (client) => {
    const store = createSystemTopicStore(client);
    assert.equal(await store.claimCommand({ updateId: 7, fromUserId: "1", text: "help", command: "help", receivedAt: 100 }), true);
    assert.equal(await store.claimCommand({ updateId: 7, fromUserId: "1", text: "help", command: "help", receivedAt: 101 }), false);
    await store.finishCommand(7, { status: "done", resultText: "Commands here:", finishedAt: 150 });
    assert.deepEqual(await store.recentCommands(20), [{ updateId: 7, fromUserId: "1", text: "help", command: "help", status: "done", resultText: "Commands here:", receivedAt: 100, finishedAt: 150 }]);
    await store.enqueueOutbox({ id: "b", text: "second", createdAt: 20 });
    await store.enqueueOutbox({ id: "a", text: "first", createdAt: 10 });
    assert.deepEqual(await store.takeOutbox(30, 20), [{ id: "a", text: "first" }, { id: "b", text: "second" }]);
    assert.deepEqual(await store.takeOutbox(40, 20), []);
    assert.equal((await store.read()).lastOutboxAt, 40);
  }));

test("a request: inserted once; it moves only from the state it is in", () =>
  withDb(async (client) => {
    const store = createSystemRequestStore(client);
    const row: SystemRequestRow = {
      id: "r1", action: "factory_media_start_session", argsJson: "{}", hash: "ea625a79", createdAt: 1, requestedBy: "operator", reason: null,
      agentEstimateUsd: 1.2, estimateUsd: 1.5, state: "posted", refusal: null, seenAt: 2, approvedAt: null, confirmedAt: null, finishedAt: null, resultJson: null,
    };
    assert.equal(await store.insert(row), true);
    assert.equal(await store.insert(row), false);
    assert.equal(await store.transition("r1", ["approved_in_topic"], { state: "confirmed" }), false);
    assert.equal(await store.transition("r1", ["posted"], { state: "approved_in_topic", approvedAt: 3 }), true);
    assert.equal(await store.transition("r1", ["approved_in_topic"], { state: "confirmed", confirmedAt: 4 }), true);
    assert.equal(await store.transition("r1", ["approved_in_topic"], { state: "confirmed", confirmedAt: 5 }), false, "a second confirm loses");
    assert.deepEqual(await store.get("r1"), { ...row, state: "confirmed", approvedAt: 3, confirmedAt: 4 });
    assert.deepEqual((await store.listByStates(["confirmed"])).map((r) => r.id), ["r1"]);
  }));

test("the requests folder: the result file arrives whole by rename; a name outside the pattern is never used", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-requests-"));
  try {
    await writeFile(path.join(dir, "r1.json"), "{}");
    assert.equal(await systemRequestFiles.read(dir, "r1.json"), "{}");
    assert.equal(await systemRequestFiles.read(dir, "r2.json"), null);
    await systemRequestFiles.writeResult(dir, "r1", "{\"status\":\"done\"}\n");
    assert.equal(await readFile(path.join(dir, "r1.result.json"), "utf8"), "{\"status\":\"done\"}\n");
    assert.deepEqual((await readdir(dir)).sort(), ["r1.json", "r1.result.json"]);
    await assert.rejects(systemRequestFiles.read(dir, "../x.json"));
    await assert.rejects(systemRequestFiles.writeResult(dir, "../x", "{}"));
    assert.equal(await systemRequestFiles.list(path.join(dir, "missing")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
