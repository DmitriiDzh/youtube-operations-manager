import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  getChannelLocalizationsRow,
  initializeDatabaseSchema,
  insertChannelLocalizationEvent,
  listChannelLocalizationEvents,
  saveChannelLocalizationsLastApply,
  saveChannelLocalizationsSet,
  SCHEMA_MIGRATIONS,
  type AppDb,
} from "@/lib/db";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md, ADR 0047; ADR 0001: additive only) on a real migrated temporary database: schema v104 adds
// `channel_localizations` (the stored set and the last apply, per channel) and `channel_localization_events` (the audit trail),
// converges when run again; saving the set keeps the last apply and recording the apply keeps the set.

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-channel-loc-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("v104: both tables exist and the migration converges when run again", () =>
  withDb(async (_database, client) => {
    await SCHEMA_MIGRATIONS.find((m) => m.version === 104)!.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    assert.ok(names.includes("channel_localizations"));
    assert.ok(names.includes("channel_localization_events"));
  }));

test("the stored set and the last apply are kept apart: each write keeps the other", () =>
  withDb(async (database) => {
    assert.equal(await getChannelLocalizationsRow("UC1", database), null);
    const at = new Date("2026-10-22T10:00:00.000Z");
    await saveChannelLocalizationsSet("UC1", { localizationsJson: "{\"es\":{\"title\":\"Es\",\"description\":\"D\"}}", updatedAt: at, updatedBy: "factory" }, database);
    await saveChannelLocalizationsLastApply("UC1", { lastApplyJson: "{\"ok\":true}", lastApplyAt: at }, database);
    await saveChannelLocalizationsSet("UC1", { localizationsJson: null, updatedAt: at, updatedBy: "owner" }, database);
    assert.deepEqual(await getChannelLocalizationsRow("UC1", database), {
      channelId: "UC1",
      localizationsJson: null,
      updatedAt: at,
      updatedBy: "owner",
      lastApplyJson: "{\"ok\":true}",
      lastApplyAt: at,
    });
  }));

test("the audit trail is listed newest first, per channel", () =>
  withDb(async (database) => {
    await insertChannelLocalizationEvent({ id: "e1", channelId: "UC1", at: new Date(1000), kind: "saved", detailJson: "{}" }, database);
    await insertChannelLocalizationEvent({ id: "e2", channelId: "UC1", at: new Date(2000), kind: "write", detailJson: "{}" }, database);
    await insertChannelLocalizationEvent({ id: "e3", channelId: "UC2", at: new Date(3000), kind: "saved", detailJson: "{}" }, database);
    assert.deepEqual((await listChannelLocalizationEvents("UC1", 50, database)).map((e) => e.id), ["e2", "e1"]);
  }));
