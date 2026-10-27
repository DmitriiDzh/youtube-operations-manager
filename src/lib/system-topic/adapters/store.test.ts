import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, SCHEMA_MIGRATIONS } from "@/lib/db";
import { createSystemTopicStore } from "./store";

// BL-228 (schema v111) on a real migrated temporary database: the migration converges when run again, a fresh database reads as
// "nothing set, switch off", the settings and the poll state are kept apart, the dropped counter adds up, and an update id is
// claimed once only (the guarantee that a message is never run twice).

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

test("v111: both tables exist and the migration converges when run again", () =>
  withDb(async (client) => {
    await SCHEMA_MIGRATIONS.find((m) => m.version === 111)!.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    assert.ok(names.includes("system_topic_state"));
    assert.ok(names.includes("system_topic_commands"));
  }));

test("a fresh database: nothing set, listening off, no offset, nothing dropped", () =>
  withDb(async (client) => {
    const state = await createSystemTopicStore(client).read();
    assert.deepEqual(state, { ownerUserId: null, chatId: null, threadId: null, listening: false, commandsPath: null, inboxSource: "none", pollOffset: null, droppedCount: 0, lastPollAt: null, lastPollError: null, updatedAt: null });
  }));

test("settings and poll state are kept apart; the dropped counter adds up", () =>
  withDb(async (client) => {
    const store = createSystemTopicStore(client);
    await store.recordPoll({ offset: 10, dropped: 2, at: 1000, error: null });
    await store.saveSettings({ ownerUserId: "331110302", chatId: "-1001234567890", threadId: "42", listening: true, commandsPath: "/x/commands.json", inboxSource: "bot_get_updates" }, 2000);
    await store.recordPoll({ offset: 12, dropped: 3, at: 3000, error: "Telegram getUpdates refused: Conflict" });
    assert.deepEqual(await store.read(), {
      ownerUserId: "331110302",
      chatId: "-1001234567890",
      threadId: "42",
      listening: true,
      commandsPath: "/x/commands.json",
      inboxSource: "bot_get_updates",
      pollOffset: 12,
      droppedCount: 5,
      lastPollAt: 3000,
      lastPollError: "Telegram getUpdates refused: Conflict",
      updatedAt: 2000,
    });
  }));

test("an update id is claimed once; the finished row is listed newest first", () =>
  withDb(async (client) => {
    const store = createSystemTopicStore(client);
    assert.equal(await store.claimCommand({ updateId: 7, fromUserId: "1", text: "help", command: "help", receivedAt: 100 }), true);
    assert.equal(await store.claimCommand({ updateId: 7, fromUserId: "1", text: "help", command: "help", receivedAt: 101 }), false);
    assert.equal(await store.claimCommand({ updateId: 8, fromUserId: "1", text: "status", command: "status", receivedAt: 200 }), true);
    await store.finishCommand(7, { status: "done", resultText: "Commands:", replyError: null, finishedAt: 150 });
    const rows = await store.recentCommands(20);
    assert.deepEqual(rows.map((r) => [r.updateId, r.status]), [[8, "received"], [7, "done"]]);
    assert.deepEqual(rows[1], { updateId: 7, fromUserId: "1", text: "help", command: "help", status: "done", resultText: "Commands:", replyError: null, receivedAt: 100, finishedAt: 150 });
    assert.equal((await store.recentCommands(1)).length, 1);
  }));
