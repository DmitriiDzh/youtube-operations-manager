import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { createIsolatedDb, initializeDatabaseSchema, insertChannelVoice, listChannelVoices, updateChannelVoice, SCHEMA_MIGRATIONS } from "@/lib/db";

// BL-236 (FO-REQ-0050, ADR 0057): schema v115 adds `channel_voices` (a name unique per channel and provider among voices that are
// not archived) and `elevenlabs_speech_jobs`. Additive: a fresh database and an upgrade both end with the two tables.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-voices-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const voice = (overrides: Record<string, unknown> = {}) => ({
  voiceId: "vc_1",
  channelId: "UC1",
  name: "Sumire",
  provider: "gemini" as const,
  providerVoiceId: null,
  description: "soft warm voice",
  model: null,
  status: "draft" as const,
  previewsJson: "[]",
  approvedPreviewId: null,
  createdAt: new Date(1),
  createdBy: "factory",
  approvedAt: null,
  approvedBy: null,
  updatedAt: new Date(1),
  ...overrides,
});

test("schema v115 exists and creates channel_voices and elevenlabs_speech_jobs", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 115));
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    const rows = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_voices', 'elevenlabs_speech_jobs') ORDER BY name");
    assert.deepEqual(rows.rows.map((r) => r.name), ["channel_voices", "elevenlabs_speech_jobs"]);
  });
});

test("a voice name is unique per channel and provider among voices not archived; an archived one frees the name; another provider or channel may reuse it", async () => {
  await withDb(async (client) => {
    await initializeDatabaseSchema(client);
    const database = createIsolatedDb(client);
    assert.equal(await insertChannelVoice(voice(), database), true);
    assert.equal(await insertChannelVoice(voice({ voiceId: "vc_2" }), database), false, "same channel, provider and name");
    assert.equal(await insertChannelVoice(voice({ voiceId: "vc_3", provider: "elevenlabs" }), database), true);
    assert.equal(await insertChannelVoice(voice({ voiceId: "vc_4", channelId: "UC2" }), database), true);
    assert.equal(await updateChannelVoice("vc_1", "draft", { status: "archived", updatedAt: new Date(2) }, database), true);
    assert.equal(await insertChannelVoice(voice({ voiceId: "vc_5" }), database), true, "the archived voice's name is free again");
    assert.equal((await listChannelVoices({ channelId: "UC1", provider: "gemini" }, database)).length, 2);
  });
});
