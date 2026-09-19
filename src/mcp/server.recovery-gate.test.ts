import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMcpToolHandlers } from "./server";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

const fakeCore = {
  listVideos: async () => ({ videos: [] }),
  getTranscript: async () => ({ status: "unavailable" as const }),
  previewMetadata: async () => ({ finalTitle: "t", description: "d" }),
  applyMetadata: async () => ({ ok: true }),
  listPlaylists: async () => ({ playlists: [] }),
  createPlaylist: async () => ({ ok: true }),
  updatePlaylist: async () => ({ ok: true }),
  deletePlaylist: async () => ({ ok: true }),
  addVideosToPlaylist: async () => ({ results: [] }),
  removeVideosFromPlaylist: async () => ({ results: [] }),
};

const fakeAuth = {
  resolveEffectiveCredentialRef: async () => ({ userId: "u1" }),
  whoami: async () => ({ activeUserId: "u1" }),
  selectUser: async () => ({ activeUserId: "u1", changed: false }),
  listKnownWriteChannels: async () => ({ channels: [] }),
  selectWriteChannel: async () => ({ ok: true }),
};

// AC-LOCK-03
test("a mutating MCP tool is rejected while the operation lock is held; a read-only tool is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(fakeCore as never, fakeAuth as never);

    const applyResult = await handlers.apply({});
    assert.equal(applyResult.isError, true);
    const applyBody = JSON.parse(applyResult.content[0].text);
    assert.equal(applyBody.error.code, "operation_lock_held");

    const listResult = await handlers.list({});
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// RISK-34 (docs/TECHNICAL_DEBT.md): the test above only exercises the operation-lock branch
// of assertDeviceAvailableForMutation. A regression that broke recovery-mode enforcement
// specifically at this MCP choke point would pass it while the real safety property
// (AGENTS.md §G) silently failed.
test("a mutating MCP tool is rejected while this device is in recovery mode (no lock held); a read-only tool is not", async () => {
  const channelId = `chan-${randomUUID()}`;
  const batchId = `batch-${randomUUID()}`;
  const rowId = `row-${randomUUID()}`;
  await rawSqlClient.execute({
    sql: "INSERT INTO channels (id, title, uploads_playlist_id) VALUES (?, ?, ?)",
    args: [channelId, "RISK-34 test channel", "UU_TEST"],
  });
  await rawSqlClient.execute({
    sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
    args: [batchId, channelId, "RUNNING"],
  });
  await rawSqlClient.execute({
    sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
    args: [rowId, batchId, "video-1", "[]", "UNKNOWN"],
  });

  try {
    const handlers = createMcpToolHandlers(fakeCore as never, fakeAuth as never);

    const applyResult = await handlers.apply({});
    assert.equal(applyResult.isError, true);
    const applyBody = JSON.parse(applyResult.content[0].text);
    assert.equal(applyBody.error.code, "device_in_recovery_mode");

    const listResult = await handlers.list({});
    assert.notEqual(listResult.isError, true);
  } finally {
    await rawSqlClient.execute({ sql: "DELETE FROM batch_ledger_rows WHERE id = ?", args: [rowId] });
    await rawSqlClient.execute({ sql: "DELETE FROM batches WHERE id = ?", args: [batchId] });
    await rawSqlClient.execute({ sql: "DELETE FROM channels WHERE id = ?", args: [channelId] });
  }
});
