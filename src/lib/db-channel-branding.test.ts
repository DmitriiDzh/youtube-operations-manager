import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  getChannelBrandingRow,
  initializeDatabaseSchema,
  insertChannelBrandingEvent,
  listChannelBrandingEvents,
  saveChannelBrandingDraft,
  saveChannelBrandingLastApply,
  SCHEMA_MIGRATIONS,
  type AppDb,
} from "@/lib/db";

// BL-223 (CHANNEL_BRANDING_PLAN.md, ADR 0050; ADR 0001: additive only) on a real migrated temporary database: schema v109 adds
// `channel_branding` (the draft and the last apply, per channel) and `channel_branding_events` (the audit trail), converges when run
// again; saving the draft keeps the last apply and recording the apply keeps the draft.

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-channel-branding-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("v109: both tables exist and the migration converges when run again", () =>
  withDb(async (_database, client) => {
    await SCHEMA_MIGRATIONS.find((m) => m.version === 109)!.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    assert.ok(names.includes("channel_branding"));
    assert.ok(names.includes("channel_branding_events"));
  }));

test("the draft and the last apply are kept apart: each write keeps the other", () =>
  withDb(async (database) => {
    assert.equal(await getChannelBrandingRow("UC1", database), null);
    const at = new Date("2026-10-25T10:00:00.000Z");
    await saveChannelBrandingDraft("UC1", { draftJson: "{\"description\":\"D\"}", updatedAt: at, updatedBy: "worker" }, database);
    await saveChannelBrandingLastApply("UC1", { lastApplyJson: "{\"ok\":true}", lastApplyAt: at }, database);
    await saveChannelBrandingDraft("UC1", { draftJson: null, updatedAt: at, updatedBy: "owner" }, database);
    assert.deepEqual(await getChannelBrandingRow("UC1", database), { channelId: "UC1", draftJson: null, updatedAt: at, updatedBy: "owner", lastApplyJson: "{\"ok\":true}", lastApplyAt: at });
  }));

test("the audit trail is listed newest first, per channel", () =>
  withDb(async (database) => {
    await insertChannelBrandingEvent({ id: "e1", channelId: "UC1", at: new Date(1000), kind: "saved", detailJson: "{}" }, database);
    await insertChannelBrandingEvent({ id: "e2", channelId: "UC1", at: new Date(2000), kind: "banner_upload", detailJson: "{}" }, database);
    await insertChannelBrandingEvent({ id: "e3", channelId: "UC2", at: new Date(3000), kind: "saved", detailJson: "{}" }, database);
    assert.deepEqual((await listChannelBrandingEvents("UC1", 50, database)).map((e) => e.id), ["e2", "e1"]);
  }));
