import assert from "node:assert/strict";
import test from "node:test";
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
