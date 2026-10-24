import assert from "node:assert/strict";
import test from "node:test";
import { runInAgentSession } from "@/lib/agent-session";
import { DomainError } from "@/lib/shared-domain";
import { listWorkerActionLogEntries } from "@/lib/db";
import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { createMcpServer } from "./server";

// WORKER_CAPABILITIES_PLAN.md AC-WK-04/06/07/09 (ADR 0048). Expected rows are written from the plan: one row per worker call that
// would really write to YouTube (apply only with dryRun:false; every call of the four playlist tools), refused calls included,
// nothing for previews and reads, and a failing log never changes the tool's answer. Each test uses its own channel id, because the
// test database is shared by the whole file.

type Tools = Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }> }>;

const playlist = { id: "p1", title: "Playlist 1", description: "D", privacyStatus: "private" as const };

function core(overrides: Record<string, unknown> = {}) {
  return {
    listVideos: async () => ({ videos: [] }),
    getTranscript: async () => ({ status: "missing" }),
    previewMetadata: async () => ({}),
    applyMetadata: async (input: unknown) => ({ dryRun: (input as { dryRun?: boolean }).dryRun !== false, videoId: "v1" }),
    listPlaylists: async () => ({ playlists: [playlist] }),
    createPlaylist: async () => ({ playlist: { ...playlist, id: "p-new" } }),
    updatePlaylist: async () => ({ playlist }),
    deletePlaylist: async () => ({ deleted: true, playlistId: "p1" }),
    addVideosToPlaylist: async () => ({ playlistId: "p1", attempted: 2, added: 1, failures: [{ videoId: "v2", reason: "already-present" as const }] }),
    removeVideosFromPlaylist: async () => ({ playlistId: "p1", requested: 1, removed: 1, failures: [] }),
    ...overrides,
  } as unknown as Parameters<typeof createMcpServer>[0];
}

async function inSession<T>(channelId: string, fn: (tools: Tools) => Promise<T>, coreOverrides: Record<string, unknown> = {}): Promise<T> {
  const server = createMcpServer(core(coreOverrides), { connectionEnabled: true, agentSession: { tokenId: `tok-${channelId}`, channelId, reverify: async () => {} } });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  return runInAgentSession({ tokenId: `tok-${channelId}`, channelId, userId: "u-1" }, () => fn(tools));
}

test("AC-WK-04: playlist_delete is not registered in a channel session", async () => {
  await inSession("UC_WL_REG", async (tools) => {
    assert.equal(tools.playlist_delete, undefined);
    assert.ok(tools.playlist_update, "the other playlist writes stay");
    assert.ok(tools.agent_list_worker_actions, "the worker log read is registered");
  });
});

test("AC-WK-06: apply with dryRun false is logged; apply as a preview (omitted or true) and reads are not", async () => {
  const channelId = "UC_WL_APPLY";
  await inSession(channelId, async (tools) => {
    await tools.apply.handler({ videoId: "v1", finalTitle: "T", description: "D", expectedChannelId: channelId });
    await tools.apply.handler({ videoId: "v1", finalTitle: "T", description: "D", expectedChannelId: channelId, dryRun: true });
    await tools.playlist_list.handler({});
    await tools.apply.handler({ videoId: "v1", finalTitle: "T", description: "D", expectedChannelId: channelId, dryRun: false });
  });
  const rows = await listWorkerActionLogEntries(channelId, 100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, "apply");
  assert.equal(rows[0].target, "v1");
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].tokenId, `tok-${channelId}`);
  assert.equal(rows[0].errorCode, null);
});

test("AC-WK-06: each playlist write leaves one row with its target; a created playlist takes its id from YouTube's answer", async () => {
  const channelId = "UC_WL_PL";
  await inSession(channelId, async (tools) => {
    await tools.playlist_create.handler({ title: "New", expectedChannelId: channelId, privacyStatus: "unlisted" });
    await tools.playlist_update.handler({ playlistId: "p1", expectedChannelId: channelId, privacyStatus: "private" });
    await tools.playlist_add_videos.handler({ playlistId: "p1", expectedChannelId: channelId, videoIds: ["v1", "v2"] });
    await tools.playlist_remove_videos.handler({ playlistId: "p1", expectedChannelId: channelId, videoIds: ["v1"] });
  });
  const rows = (await listWorkerActionLogEntries(channelId, 100)).reverse();
  assert.deepEqual(
    rows.map((row) => [row.tool, row.target, row.outcome]),
    [
      ["playlist_create", "p-new", "ok"],
      ["playlist_update", "p1", "ok"],
      ["playlist_add_videos", "p1", "ok"],
      ["playlist_remove_videos", "p1", "ok"],
    ]
  );
  assert.deepEqual(JSON.parse(rows[0].detail ?? "{}"), { title: "New", privacyStatus: "unlisted" });
  assert.deepEqual(JSON.parse(rows[1].detail ?? "{}"), { fields: ["privacyStatus"], privacyStatus: "private" });
  assert.deepEqual(JSON.parse(rows[2].detail ?? "{}"), { videoIds: ["v1", "v2"], failedVideos: 1 });
});

test("AC-WK-06: a refused write is logged with its error code", async () => {
  const channelId = "UC_WL_REFUSED";
  await inSession(
    channelId,
    async (tools) => {
      const result = await tools.playlist_update.handler({ playlistId: "p1", expectedChannelId: channelId, privacyStatus: "public" });
      assert.equal(result.isError, true);
    },
    {
      updatePlaylist: async () => {
        throw new DomainError({ code: "AGENT_PUBLIC_NOT_ALLOWED", message: "no" });
      },
    }
  );
  const rows = await listWorkerActionLogEntries(channelId, 100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].errorCode, "AGENT_PUBLIC_NOT_ALLOWED");
});

test("AC-WK-07: a log row that cannot be written does not change the tool's answer", async () => {
  // The row is made unwritable by a channel id the table refuses (NOT NULL); the wrapper must still return the tool's own success.
  const server = createMcpServer(core(), { connectionEnabled: true, agentSession: { tokenId: "tok-null", channelId: null as unknown as string, reverify: async () => {} } });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await runInAgentSession({ tokenId: "tok-null", channelId: "UC_WL_NULL", userId: "u-1" }, () =>
      tools.playlist_update.handler({ playlistId: "p1", expectedChannelId: "UC_WL_NULL", title: "T" })
    );
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as { playlist: { id: string } }).playlist.id, "p1");
  } finally {
    console.error = originalError;
  }
});

test("AC-WK-09: agent_list_worker_actions returns only the bound channel's rows", async () => {
  await inSession("UC_WL_A", async (tools) => {
    await tools.playlist_update.handler({ playlistId: "pa", expectedChannelId: "UC_WL_A", title: "A" });
  });
  await inSession("UC_WL_B", async (tools) => {
    await tools.playlist_update.handler({ playlistId: "pb", expectedChannelId: "UC_WL_B", title: "B" });
  });
  const listed = await inSession("UC_WL_A", (tools) => tools.agent_list_worker_actions.handler({}));
  const actions = (listed.structuredContent as { actions: Array<{ tool: string; target: string }> }).actions;
  assert.deepEqual(
    actions.map((action) => action.target),
    ["pa"]
  );
});

test("AC-WK-06: a write refused because the token was revoked is logged too", async () => {
  const channelId = "UC_WL_REVOKED";
  const server = createMcpServer(core(), {
    connectionEnabled: true,
    agentSession: {
      tokenId: `tok-${channelId}`,
      channelId,
      reverify: async () => {
        throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "revoked" });
      },
    },
  });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  await runInAgentSession({ tokenId: `tok-${channelId}`, channelId, userId: "u-1" }, async () => {
    const result = await tools.playlist_update.handler({ playlistId: "p1", expectedChannelId: channelId, privacyStatus: "private" });
    assert.equal(result.isError, true);
    const read = await tools.playlist_list.handler({});
    assert.equal(read.isError, true);
  });
  const rows = await listWorkerActionLogEntries(channelId, 100);
  assert.deepEqual(
    rows.map((row) => [row.tool, row.target, row.errorCode]),
    [["playlist_update", "p1", "AGENT_TOKEN_INVALID"]],
    "the refused write is logged, the refused read is not"
  );
});

test("AC-WK-01/02 end to end: through the MCP tools and the real playlist core, public is refused and the refusal is logged", async () => {
  const channelId = "UC_WL_REAL";
  const real = { ...createVideoMetadataCore(), ...createPlaylistManagementCore() };
  const server = createMcpServer(real, { connectionEnabled: true, agentSession: { tokenId: `tok-${channelId}`, channelId, reverify: async () => {} } });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  await runInAgentSession({ tokenId: `tok-${channelId}`, channelId, userId: "u-1" }, async () => {
    for (const result of [
      await tools.playlist_create.handler({ title: "X", expectedChannelId: channelId, privacyStatus: "public" }),
      await tools.playlist_update.handler({ playlistId: "p1", expectedChannelId: channelId, privacyStatus: "public" }),
    ]) {
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).error.code, "AGENT_PUBLIC_NOT_ALLOWED");
    }
  });
  const rows = (await listWorkerActionLogEntries(channelId, 100)).reverse();
  assert.deepEqual(
    rows.map((row) => [row.tool, row.outcome, row.errorCode]),
    [
      ["playlist_create", "error", "AGENT_PUBLIC_NOT_ALLOWED"],
      ["playlist_update", "error", "AGENT_PUBLIC_NOT_ALLOWED"],
    ]
  );
});

test("AC-WP-07: agent_set_privacy is logged only when it would write (dryRun:false), refusals included", async () => {
  const channelId = "UC_WL_PRIVACY";
  await inSession(channelId, async (tools) => {
    assert.ok(tools.agent_set_privacy, "registered for a worker");
    // Unknown to this channel's (empty) synced list: refused not_found, before anything reaches YouTube.
    await tools.agent_set_privacy.handler({ target: "video", id: "v-unknown", privacyStatus: "private" });
    const refused = await tools.agent_set_privacy.handler({ target: "video", id: "v-unknown", privacyStatus: "private", dryRun: false });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).error.code, "not_found");
  });
  const rows = await listWorkerActionLogEntries(channelId, 100);
  assert.deepEqual(
    rows.map((row) => [row.tool, row.target, row.errorCode, JSON.parse(row.detail ?? "{}")]),
    [["agent_set_privacy", "v-unknown", "not_found", { target: "video", privacyStatus: "private" }]]
  );
});

test("BL-217: the worker versions of the Operator's channel tools are registered, and a refused local write is logged", async () => {
  const channelId = "UC_WL_FACTORY";
  await inSession(channelId, async (tools) => {
    for (const name of ["agent_plan_create", "agent_storyboard_submit", "agent_video_create", "agent_live_get_status"]) {
      assert.ok(tools[name], `${name} registered`);
    }
    // Stage 4 (owner msg 3402) added the paid tools; move and the factory_ names themselves stay out.
    for (const name of ["agent_plan_move", "factory_plan_create", "agent_media_pull_model"]) {
      assert.equal(tools[name], undefined, `${name} not registered`);
    }
    const refused = await tools.agent_video_create.handler({ channelId: "UC_OTHER" });
    assert.equal(refused.isError, true);
    const read = await tools.agent_storyboard_list.handler({ channelId: "UC_OTHER" });
    assert.equal(read.isError, true);
  });
  const rows = await listWorkerActionLogEntries(channelId, 100);
  assert.deepEqual(
    rows.map((row) => [row.tool, row.outcome, row.errorCode]),
    [["agent_video_create", "error", "CHANNEL_NOT_ACTIVE"]],
    "the refused write is logged; the refused read is not"
  );
});
