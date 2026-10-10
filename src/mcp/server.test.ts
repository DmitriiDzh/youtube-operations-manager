import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DomainError } from "@/lib/shared-domain";
import { runInAgentSession } from "@/lib/agent-session";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import type { PlaylistManagementCore } from "@/lib/playlist-management";
import type { ChangeSetCore } from "@/lib/changesets";
import type { BatchCore } from "@/lib/batches";
import type { ChannelSyncCore } from "@/lib/channel-sync";
import type { ChannelAccessCore } from "@/lib/channel-access";
import type { AnalyticsCore } from "@/lib/analytics";
import type { AiLocalizationCore } from "@/lib/ai-localization";
import type { AgentOperationsCore } from "@/lib/agent-operations";
import type { MarketIntelligenceCore } from "@/lib/market-intelligence";
import type { DecisionEngineCore } from "@/lib/decision-engine";
import { AGENT_API_VERSION } from "@/lib/agent-operations";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";
import { createMcpServer, createMcpToolHandlers } from "./server";

// Default depth (50 videos, no date), nothing collected yet: first collection = 1 channels.list + 1 page = 2 units, worst case 3.
const STUB_COLLECTION_PROGRESS = {
  maxVideosPerChannel: 50,
  maxVideosPerChannelOverride: null,
  publishedAfter: null,
  publishedAfterOverride: null,
  videosStored: 0,
  complete: false,
  completeReason: null,
  estimatedFirstCollectionUnits: 2,
  estimatedFirstCollectionWorstCaseUnits: 3,
};

// Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-01): tools are registered only for a
// channel-bound agent session. Tests that exercise registered tools inject one explicitly (a test
// seam, never a relaxed production rule); its token is treated as always valid.
const TEST_AGENT_SESSION = { tokenId: "test-token", channelId: "UC_1", reverify: async () => {} };

function makeCoreStub(): Pick<
  VideoMetadataCore & PlaylistManagementCore,
  | "listVideos"
  | "getTranscript"
  | "previewMetadata"
  | "applyMetadata"
  | "listPlaylists"
  | "createPlaylist"
  | "updatePlaylist"
  | "deletePlaylist"
  | "addVideosToPlaylist"
  | "removeVideosFromPlaylist"
> {
  return {
    listVideos: async (input: unknown) => {
      void input;
      return { videos: [] };
    },
    getTranscript: async (input: unknown) => {
      void input;
      return { transcript: { status: "available" as const, text: "Transcript" } };
    },
    previewMetadata: async (input: unknown) => {
      void input;
      return {
        video: { videoId: "v1", title: "Video", description: "Desc", publishedAt: "2024-01-01" },
        transcript: { status: "available" as const, text: "Transcript" },
        draft: {
          finalTitle: "Final",
          description: "Description",
          promptVersion: "video-metadata-v1",
        },
      };
    },
    applyMetadata: async (input: unknown) => {
      void input;
      return {
        dryRun: true,
        videoId: "v1",
        targetLanguage: "es",
        languageSource: "defaultLanguage" as const,
        snippet: {
          before: { title: "Before", description: "Before desc", categoryId: "22" },
          proposed: { title: "After", description: "After desc", categoryId: "22" },
        },
        localizations: {
          before: {
            es: { title: "Antes", description: "Antes desc" },
            en: { title: "Before EN", description: "Before desc EN" },
          },
          proposed: {
            es: { title: "After", description: "After desc" },
            en: { title: "Before EN", description: "Before desc EN" },
          },
          affected: [
            {
              locale: "es",
              before: { title: "Antes", description: "Antes desc" },
              proposed: { title: "After", description: "After desc" },
              source: "defaultLanguage" as const,
            },
          ],
        },
      };
    },
    listPlaylists: async () => ({
      playlists: [
        {
          id: "p1",
          title: "Playlist 1",
          description: "Playlist description",
          privacyStatus: "private" as const,
        },
      ],
    }),
    createPlaylist: async (input: unknown) => {
      void input;
      return {
        playlist: {
          id: "p1",
          title: "Playlist 1",
          description: "Playlist description",
          privacyStatus: "private" as const,
        },
      };
    },
    updatePlaylist: async () => ({
      playlist: {
        id: "p1",
        title: "Playlist 1",
        description: "Playlist description",
        privacyStatus: "private" as const,
      },
    }),
    deletePlaylist: async () => ({ deleted: true, playlistId: "p1" }),
    addVideosToPlaylist: async () => ({
      playlistId: "p1",
      attempted: 2,
      added: 1,
      failures: [{ videoId: "v2", reason: "already-present" as const }],
    }),
    removeVideosFromPlaylist: async () => ({
      playlistId: "p1",
      requested: 2,
      removed: 1,
      failures: [{ videoId: "v2", reason: "not-found-in-playlist" as const }],
    }),
  };
}

function makeAuthStub() {
  return {
    whoami: async () => ({
      userId: "active-user",
      email: "active-user@example.com",
      name: null,
      tokenExpiry: null,
      hasRefreshToken: true,
      isActive: true,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      knownChannels: [
        {
          id: "UC_ACTIVE",
          title: "Active channel",
          source: "active",
          isActive: true,
          isSelected: false,
        },
        {
          id: "UC_SELECTED",
          title: null,
          source: "selected",
          isActive: false,
          isSelected: true,
        },
      ],
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [
          {
            id: "UC_ACTIVE",
            title: "Active channel",
            source: "active",
            isActive: true,
            isSelected: false,
          },
          {
            id: "UC_SELECTED",
            title: null,
            source: "selected",
            isActive: false,
            isSelected: true,
          },
        ],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      effectiveCredentialRef: { userId: "active-user" },
    }),
    selectUser: async ({ userId }: { userId: string }) => ({
      activeUser: {
        userId,
        email: `${userId}@example.com`,
        name: null,
        tokenExpiry: null,
        hasRefreshToken: true,
        isActive: true,
      },
      previousActiveUserId: "active-user",
      changed: userId !== "active-user",
      effectiveCredentialRef: { userId },
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      affectsRemoteOAuth: false as const,
    }),
    listKnownWriteChannels: async () => ({
      knownChannels: [
        {
          id: "UC_ACTIVE",
          title: "Active channel",
          source: "active",
          isActive: true,
          isSelected: false,
        },
        {
          id: "UC_SELECTED",
          title: null,
          source: "selected",
          isActive: false,
          isSelected: true,
        },
      ],
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      expectedChannelId: "UC_SELECTED",
      source: "stored",
      requiresReauth: true,
    }),
    selectWriteChannel: async ({ channelId }: { channelId: string }) => ({
      selectedChannelId: channelId,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      expectedChannelId: channelId,
      source: "stored",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      knownChannels: [],
      requiresReauth: true,
      message: "Selected expected channel does not match the active OAuth channel.",
      recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
    }),
    resolveEffectiveCredentialRef: async ({ explicit }: { explicit?: unknown }) =>
      (explicit as { userId: string } | undefined) ?? { userId: "active-user" },
  };
}

function makeApplyPayload(dryRun: boolean) {
  return {
    dryRun,
    videoId: "v1",
    targetLanguage: "es",
    languageSource: "defaultLanguage" as const,
    snippet: {
      before: { title: "Before", description: "Before desc", categoryId: "22" },
      proposed: { title: "After", description: "After desc", categoryId: "22" },
    },
    localizations: {
      before: {
        es: { title: "Antes", description: "Antes desc" },
      },
      proposed: {
        es: { title: "After", description: "After desc" },
      },
      affected: [
        {
          locale: "es",
          before: { title: "Antes", description: "Antes desc" },
          proposed: { title: "After", description: "After desc" },
          source: "defaultLanguage" as const,
        },
      ],
    },
  };
}

test("MCP whoami returns active local user", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.whoami();

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { userId: string; email: string };
  assert.equal(payload.userId, "active-user");
  assert.equal(payload.email, "active-user@example.com");
});

// Requirement changed by the owner's Phase 12 decision (Telegram, msg 1048; PHASE_12_PLAN.md
// AC-P12-04): identity/selection-switching tools are operator-only and never exist in an agent
// session. This test previously asserted auth_user_select WAS registered.
test("MCP agent session: identity/selection-switching tools are never registered", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};

  for (const name of ["auth_user_select", "write_channel_select", "write_channel_list"]) {
    assert.equal(Boolean(tools[name]), false, `${name} must not be registered`);
  }
});

// Phase 9 slice 4 -- the handler tests above only prove createMcpToolHandlers().queryCompetitors/
// queryMarketIntelligence behave correctly when called directly; this proves the two literal MCP
// tool names PLANNED_FUTURE_CAPABILITIES reserved are actually wired into createMcpServer's real
// registration, using the real default createMarketIntelligenceCore() (an empty local watchlist,
// so both calls succeed with an empty/not-found result rather than needing a fixture).
// Phase 12 slice 12.4 (owner decision D1): market tools exist in an agent session, but every result is
// narrowed to records assigned to the agent's channel. This test previously asserted (Phase 9 slice 4)
// that the full global watchlist was returned; the owner's D1 decision changed that requirement.
test("MCP market tools narrow results to the agent channel's assignments and record request ownership", async () => {
  const assigned: Record<string, string[]> = { research_channel: ["UCresearchA"], topic: ["topic-a"], trend_candidate: [], discovery_candidate: ["UCdiscA"] };
  const owned: Array<[string, string]> = [];
  const marketAssignmentCore = {
    async filterForAgent<T>(kind: string, items: T[], idOf: (item: T) => string) {
      return items.filter((item) => (assigned[kind] ?? []).includes(idOf(item)));
    },
    async assertAvailableToAgent(kind: string, id: string) {
      if (!(assigned[kind] ?? []).includes(id)) throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "no" });
    },
    async recordAgentOwnership(kind: string, id: string) {
      owned.push([kind, id]);
    },
  };
  const marketIntelligenceCore = {
    async listWatchlist() {
      return { channels: [{ channelId: "UCresearchA" }, { channelId: "UCresearchB" }] };
    },
    async getWatchlistEntryContext() {
      return {
        channel: { channelId: "UCresearchA" },
        topicAssignments: [
          { assignmentId: "as-1", topicId: "topic-a" },
          { assignmentId: "as-2", topicId: "topic-b" },
        ],
      };
    },
    async listTopics() {
      return { topics: [{ topicId: "topic-a" }, { topicId: "topic-b" }] };
    },
    async listTrendCandidates() {
      return { trendCandidates: [{ trendCandidateId: "trend-a" }] };
    },
    async listDiscoveryCandidates() {
      return { candidates: [{ channelId: "UCdiscA" }, { channelId: "UCdiscB" }] };
    },
    async createMarketResearchRequest() {
      return { requestId: "req-1" };
    },
  } as never;
  const handlers = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, makeChannelAccessCoreStub(),
    undefined, undefined, undefined, marketIntelligenceCore, undefined, undefined, marketAssignmentCore
  );
  const parse = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

  assert.deepEqual(parse(await handlers.queryCompetitors({})).channels, [{ channelId: "UCresearchA" }]);
  assert.equal(parse(await handlers.queryMarketIntelligence({ channelId: "UCresearchB" })).error.code, "RESEARCH_CHANNEL_NOT_AVAILABLE");
  // Nested topic tags are narrowed too: topic-b is not assigned to the agent's channel.
  assert.deepEqual(
    parse(await handlers.queryMarketIntelligence({ channelId: "UCresearchA" })).topicAssignments.map((a: { topicId: string }) => a.topicId),
    ["topic-a"]
  );
  assert.deepEqual(parse(await handlers.agentListMarketRecords({ kind: "topics" })).topics, [{ topicId: "topic-a" }]);
  assert.deepEqual(parse(await handlers.agentListMarketRecords({ kind: "trend_candidates" })).trendCandidates, []);
  assert.deepEqual(parse(await handlers.agentListMarketRecords({ kind: "discovery_candidates" })).candidates, [{ channelId: "UCdiscA" }]);
  await handlers.agentCreateMarketResearchRequest({ query: "q", rationale: "r" });
  assert.deepEqual(owned, [["research_request", "req-1"]]);
});

// The SDK validates an incoming tool call against the REGISTERED inputSchema, using its OWN
// parsed output as what the handler actually receives -- BEFORE agentFindComparableVideos ever
// runs (McpServer.validateToolInput -> executeToolHandler, node_modules/@modelcontextprotocol/
// sdk's own server/mcp.js). Registering the full, refined findComparableVideosInputSchema here
// would let the SDK itself reject a real call requesting performanceMetric without an explicit
// credentialRef -- before the handler's own resolve-then-inject logic (tested above via the
// handler directly, which bypasses the SDK) ever gets a chance to run. This test exercises the
// REAL registered schema object, not the handler, to prove that specific gap is actually closed.
test("MCP server registers agent_find_comparable_videos with an SDK-facing schema that does not itself require credentialRef when performanceMetric is set", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, { inputSchema?: { safeParse: (input: unknown) => { success: boolean } } }> })
    ._registeredTools;
  const tool = tools?.agent_find_comparable_videos;
  assert.ok(tool?.inputSchema);

  const result = tool.inputSchema.safeParse({
    channelId: "UC_1",
    anchorVideoId: "v1",
    performanceMetric: "views",
    sort: "performanceMetric",
  });
  assert.equal(result.success, true);
});

test("MCP server registers agent_list_asset_performance with an SDK-facing schema that does not itself require credentialRef when performanceMetric is set", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, { inputSchema?: { safeParse: (input: unknown) => { success: boolean } } }> })
    ._registeredTools;
  const tool = tools?.agent_list_asset_performance;
  assert.ok(tool?.inputSchema);

  const result = tool.inputSchema.safeParse({
    channelId: "UC_1",
    performanceMetric: "views",
    performanceDayOffset: 5,
  });
  assert.equal(result.success, true);
});

// "MCP connection" gate (owner instruction, 2026-09-21, renamed and inverted from the earlier
// "MCP restricted mode"): a single boolean now decides whether ANY tool is registered at all,
// not a per-tool exclusion list. Default (no option passed) must be fully disconnected -- zero
// tools, not even read-only ones.

function registeredToolNames(server: ReturnType<typeof createMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return Object.keys(tools ?? {});
}

test("MCP server (default, no option passed) registers zero tools", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub()));
  assert.deepEqual(names, []);
});

test("MCP server (connectionEnabled: false) registers zero tools, including every read-only one", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: false }));

  for (const tool of [
    "whoami",
    "list",
    "transcript",
    "preview",
    "playlist_list",
    "changeset_list",
    "changeset_get",
    "batch_list",
    "batch_get",
    "channel_sync",
    "channel_list",
    "channel_video_list",
    "analytics_list",
    "analytics_overview",
    "analytics_data_quality",
    "apply",
    "playlist_create",
    "write_channel_select",
    "auth_user_select",
  ]) {
    assert.equal(names.includes(tool), false, `expected ${tool} to be omitted while disconnected`);
  }
});

test("MCP server (connectionEnabled: true, agent session) registers every bound tool, including writes", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION }));

  for (const tool of [
    "whoami",
    "list",
    "transcript",
    "preview",
    "playlist_list",
    "changeset_list",
    "changeset_get",
    "localization_import_preview",
    "changeset_create_from_import",
    "batch_list",
    "batch_get",
    "channel_sync",
    "channel_list",
    "channel_video_list",
    "analytics_list",
    "analytics_overview",
    "analytics_data_quality",
    "apply",
    "playlist_create",
    "playlist_update",
    "playlist_delete",
    "playlist_add_videos",
    "playlist_remove_videos",
    "write_context",
    // Slice K: proves the real MCP SDK's own server.registerTool() accepts
    // findComparableVideosInputSchema (a ZodEffects, via .refine()) without throwing --
    // registration itself is real here, unlike the handler-level tests above which bypass the SDK.
    "agent_find_comparable_videos",
    // Slice L: same proof for listAssetPerformanceSdkInputSchema.
    "agent_list_asset_performance",
  ]) {
    assert.equal(names.includes(tool), true, `expected ${tool} to be registered once connected`);
  }
});

// Mechanical enforcement of "один шлюз" for the MCP connection gate (owner instruction,
// 2026-09-21): the local `registerTool` wrapper (which checks `connectionEnabled`) must be the
// ONLY call site that ever calls the SDK's real `server.registerTool`. A future tool added via
// `server.registerTool(...)` directly, bypassing the wrapper, would silently escape the gate --
// this test fails the build the moment that happens, mirroring
// `src/lib/youtube-write-gateway/gateway-inventory.test.ts`'s same "enforced by a test, not by
// convention" principle for the write funnel.
test("MCP connection gate inventory: server.registerTool is called from exactly one place in this file (the local registerTool wrapper)", async () => {
  const thisFile = fileURLToPath(import.meta.url);
  const serverFile = path.join(path.dirname(thisFile), "server.ts");
  const content = await readFile(serverFile, "utf8");

  const matches = content.match(/server\.registerTool\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one "server.registerTool(" call site in src/mcp/server.ts (inside the ` +
      `local registerTool wrapper), found ${matches.length} -- a second call site would bypass ` +
      `the connectionEnabled gate entirely`
  );
});

// Mechanical check that `createMcpToolHandlers` (the raw handlers, unprotected by the
// connection gate -- only `registerTool`'s SDK call is gated) is never imported anywhere except
// this file and its own test, so no other surface can invoke a tool's logic while bypassing MCP
// tool registration entirely.
test("MCP connection gate inventory: createMcpToolHandlers is imported nowhere outside src/mcp/server.ts and its own test", async () => {
  const thisFile = fileURLToPath(import.meta.url);
  const mcpDir = path.dirname(thisFile);
  const repoRoot = path.resolve(mcpDir, "..", "..");
  const srcDir = path.join(repoRoot, "src");

  async function listTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  const allowed = new Set([
    path.join(mcpDir, "server.ts"),
    path.join(mcpDir, "server.test.ts"),
    path.join(mcpDir, "server.recovery-gate.test.ts"),
  ]);
  const offenders: string[] = [];

  for (const file of await listTsFiles(srcDir)) {
    if (allowed.has(file)) continue;
    const content = await readFile(file, "utf8");
    if (/\bcreateMcpToolHandlers\s*\(/.test(content)) {
      offenders.push(path.relative(repoRoot, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `createMcpToolHandlers is called outside src/mcp/server.ts, bypassing the connection gate ` +
      `entirely: ${offenders.join(", ")}`
  );
});

test("MCP write_context returns active write-channel contract", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeContext();

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    activeWriteChannel: { id: string };
    selectedChannelId: string;
    effectiveCredentialRef: { userId: string };
  };

  assert.equal(payload.activeWriteChannel.id, "UC_ACTIVE");
  assert.equal(payload.selectedChannelId, "UC_SELECTED");
  assert.deepEqual(payload.effectiveCredentialRef, { userId: "active-user" });
});

test("MCP write_channel_list returns minimal-safe known channel list", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeChannelList({});

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    knownChannels: Array<{ id: string; source: string }>;
    alignment: { status: string; requiresReauth: boolean };
  };
  assert.equal(payload.knownChannels.length, 2);
  assert.equal(payload.alignment.status, "mismatch");
  assert.equal(payload.alignment.requiresReauth, true);
});

test("MCP write_channel_select returns mismatch contract without implying OAuth switch", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeChannelSelect({
    channelId: "UC1111111111111111111111",
  });

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    selectedChannelId: string;
    alignment: { status: string; requiresReauth: boolean };
    message: string;
  };
  assert.equal(payload.selectedChannelId, "UC1111111111111111111111");
  assert.equal(payload.alignment.status, "mismatch");
  assert.equal(payload.alignment.requiresReauth, true);
  assert.match(payload.message, /does not match the active OAuth channel/i);
});

test("MCP write_channel_select rejects invalid payload before persistence", async () => {
  let selectCalled = false;
  const auth = makeAuthStub();
  auth.selectWriteChannel = async () => {
    selectCalled = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.writeChannelSelect({ channelId: "" });

  assert.equal(result.isError, true);
  assert.equal(selectCalled, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP auth_user_select switches local active identity only", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.authUserSelect({ userId: "user-b" });

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    activeUser: { userId: string };
    previousActiveUserId: string;
    affectsRemoteOAuth: boolean;
  };
  assert.equal(payload.activeUser.userId, "user-b");
  assert.equal(payload.previousActiveUserId, "active-user");
  assert.equal(payload.affectsRemoteOAuth, false);
});

test("MCP auth_user_select rejects invalid payload before persistence", async () => {
  let selectCalled = false;
  const auth = makeAuthStub();
  auth.selectUser = async () => {
    selectCalled = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.authUserSelect({ userId: "" });

  assert.equal(result.isError, true);
  assert.equal(selectCalled, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP auth_user_select returns AUTH_USER_NOT_FOUND as structured error", async () => {
  const auth = makeAuthStub();
  auth.selectUser = async () => {
    throw new DomainError({
      code: "AUTH_USER_NOT_FOUND",
      message: "Requested auth user does not exist in local storage",
      details: { userId: "missing-user", affectsRemoteOAuth: false },
    });
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.authUserSelect({ userId: "missing-user" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_USER_NOT_FOUND");
  assert.deepEqual(payload.error.details, {
    userId: "missing-user",
    affectsRemoteOAuth: false,
  });
});

test("MCP preview tool returns finalTitle and description for valid input", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const result = await handlers.preview({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    editorialPrompt: "Improve title",
  });

  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as {
    draft: { finalTitle: string; description: string };
  };
  assert.equal(structured.draft.finalTitle, "Final");
  assert.equal(structured.draft.description, "Description");
});

test("MCP handlers reject invalid input with structured validation error", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const result = await handlers.preview({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "validation_failed");
  assert.equal(Array.isArray(payload.error.details), true);
});

test("MCP apply tool supports dry-run review without mutation", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    capturedInput = input;
    return {
      dryRun: true,
      videoId: "v1",
      targetLanguage: "es",
      languageSource: "defaultLanguage" as const,
      snippet: {
        before: { title: "Before", description: "Before desc", categoryId: "22" },
        proposed: { title: "After", description: "After desc", categoryId: "22" },
      },
      localizations: {
        before: {
          es: { title: "Antes", description: "Antes desc" },
        },
        proposed: {
          es: { title: "After", description: "After desc" },
        },
        affected: [
          {
            locale: "es",
            before: { title: "Antes", description: "Antes desc" },
            proposed: { title: "After", description: "After desc" },
            source: "defaultLanguage" as const,
          },
        ],
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  const payload = result.structuredContent as {
    dryRun: boolean;
    targetLanguage: string;
    localizations: { affected: Array<{ locale: string }> };
  };
  assert.equal(payload.dryRun, true);
  assert.equal(payload.targetLanguage, "es");
  assert.equal(payload.localizations.affected[0]?.locale, "es");
});

test("MCP apply keeps structuredContent parity between dryRun and apply", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    const request = input as { dryRun?: boolean };
    return makeApplyPayload(request.dryRun === true);
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());

  const dryRunResult = await handlers.apply({
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  const applyResult = await handlers.apply({
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: false,
  });

  assert.equal(dryRunResult.isError, undefined);
  assert.equal(applyResult.isError, undefined);

  const dryRunPayload = {
    ...(dryRunResult.structuredContent as Record<string, unknown>),
  };
  const applyPayload = {
    ...(applyResult.structuredContent as Record<string, unknown>),
  };

  assert.equal(dryRunPayload.dryRun, true);
  assert.equal(applyPayload.dryRun, false);
  delete dryRunPayload.dryRun;
  delete applyPayload.dryRun;
  assert.deepEqual(dryRunPayload, applyPayload);
});

test("MCP transcript keeps structuredContent and text payload aligned with diagnostics", async () => {
  const core = makeCoreStub();
  core.getTranscript = async () => ({
    transcript: {
      status: "unavailable",
      reason: "captions-not-downloadable",
      diagnostic: {
        stage: "captions-download",
        httpStatus: 403,
        apiReason: "forbidden",
        retriable: false,
      },
    },
  });

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.transcript({ videoId: "v1" });

  assert.equal(result.isError, undefined);
  const payloadFromText = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(result.structuredContent, payloadFromText);
  assert.deepEqual(payloadFromText.transcript, {
    status: "unavailable",
    reason: "captions-not-downloadable",
    diagnostic: {
      stage: "captions-download",
      httpStatus: 403,
      apiReason: "forbidden",
      retriable: false,
    },
  });
});

test("MCP list uses active auth context when credentialRef is omitted", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.list({ maxResults: 5 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    maxResults: 5,
  });
});

test("MCP list forwards explicit channelId for multi-account setups", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  await handlers.list({ channelId: "IscmdXDtypp2zTzEEYxJwg", maxResults: 5 });

  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    channelId: "IscmdXDtypp2zTzEEYxJwg",
    maxResults: 5,
  });
});

test("MCP keeps explicit credentialRef precedence over active user", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  await handlers.list({ credentialRef: { userId: "explicit-user" } });

  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "explicit-user" },
  });
});

test("MCP returns AUTH_USER_NOT_FOUND as structured error", async () => {
  const auth = {
    whoami: async () => ({
      userId: "active-user",
      email: "active-user@example.com",
      name: null,
      tokenExpiry: null,
      hasRefreshToken: true,
      isActive: true,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      knownChannels: [],
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      effectiveCredentialRef: { userId: "active-user" },
    }),
    listKnownWriteChannels: async () => ({
      knownChannels: [],
      alignment: {
        status: "unresolved",
        requiresReauth: false,
        message: "No expected write channel is configured yet.",
        recommendedAction: "Select the expected channel before running sensitive write operations.",
      },
      activeWriteChannel: null,
      selectedChannelId: null,
      expectedChannelId: null,
      source: "missing",
      requiresReauth: false,
    }),
    selectWriteChannel: async () => ({
      selectedChannelId: "UC1111111111111111111111",
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      expectedChannelId: "UC1111111111111111111111",
      source: "stored",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      knownChannels: [],
      requiresReauth: true,
      message: "Selected expected channel does not match the active OAuth channel.",
      recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
    }),
    selectUser: async () => ({
      activeUser: {
        userId: "active-user",
        email: "active-user@example.com",
        name: null,
        tokenExpiry: null,
        hasRefreshToken: true,
        isActive: true,
      },
      previousActiveUserId: "active-user",
      changed: false,
      effectiveCredentialRef: { userId: "active-user" },
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      affectsRemoteOAuth: false as const,
    }),
    resolveEffectiveCredentialRef: async () => {
      throw new DomainError({
        code: "AUTH_USER_NOT_FOUND",
        message: "Active auth user does not exist",
      });
    },
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.list({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_USER_NOT_FOUND");
});

test("MCP returns AUTH_SCOPE_INSUFFICIENT as structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "AUTH_SCOPE_INSUFFICIENT",
      message: "Credentials are missing required OAuth scopes",
      details: { missingScopes: ["https://www.googleapis.com/auth/youtube"] },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "New",
    description: "New desc",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_SCOPE_INSUFFICIENT");
});

test("MCP playlist_list uses active auth context when credentialRef is omitted", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listPlaylists = async (input: unknown) => {
    capturedInput = input;
    return { playlists: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistList({});

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
  });
});

test("MCP playlist_create keeps explicit credentialRef precedence", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.createPlaylist = async (input: unknown) => {
    capturedInput = input;
    return {
      playlist: {
        id: "p-created",
        title: "My Playlist",
        description: "Roadtrip videos",
        privacyStatus: "private" as const,
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistCreate({
    credentialRef: { userId: "explicit-user" },
    title: "My Playlist",
    description: "Roadtrip videos",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "explicit-user" },
    title: "My Playlist",
    description: "Roadtrip videos",
    expectedChannelId: "UC_ACTIVE",
    privacyStatus: "private",
  });

  const payload = result.structuredContent as {
    playlist: { id: string; title: string; description: string; privacyStatus: string };
  };
  assert.equal(payload.playlist.id, "p-created");
  assert.equal(payload.playlist.title, "My Playlist");
  assert.equal(payload.playlist.description, "Roadtrip videos");
  assert.equal(payload.playlist.privacyStatus, "private");
});

test("MCP playlist_update enforces patch schema and forwards payload", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.updatePlaylist = async (input: unknown) => {
    capturedInput = input;
    return {
      playlist: {
        id: "p-updated",
        title: "Updated",
        description: "Updated description",
        privacyStatus: "public" as const,
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-updated",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
    privacyStatus: "public",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p-updated",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
    privacyStatus: "public",
  });
  assert.deepEqual(result.structuredContent, {
    playlist: {
      id: "p-updated",
      title: "Updated",
      description: "Updated description",
      privacyStatus: "public",
    },
  });
});

test("MCP playlist_delete enforces schema and forwards expectedChannelId", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.deletePlaylist = async (input: unknown) => {
    capturedInput = input;
    return { deleted: true, playlistId: "p-delete" };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistDelete({
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.deepEqual(result.structuredContent, {
    deleted: true,
    playlistId: "p-delete",
  });
});

test("MCP playlist_* tools reject invalid input with structured validation errors", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const invalidCalls = [
    {
      toolName: "playlist_list",
      invoke: () => handlers.playlistList({ maxResults: 0 }),
    },
    {
      toolName: "playlist_create",
      invoke: () => handlers.playlistCreate({ title: "" }),
    },
    {
      toolName: "playlist_add_videos",
      invoke: () => handlers.playlistAddVideos({ playlistId: "p1", videoIds: [] }),
    },
    {
      toolName: "playlist_remove_videos",
      invoke: () => handlers.playlistRemoveVideos({ playlistId: "p1", videoIds: [] }),
    },
    {
      toolName: "playlist_delete",
      invoke: () => handlers.playlistDelete({ playlistId: "p1" }),
    },
    {
      toolName: "playlist_update",
      invoke: () => handlers.playlistUpdate({ playlistId: "p1", expectedChannelId: "UC_ACTIVE" }),
    },
  ];

  for (const invalidCall of invalidCalls) {
    const result = await invalidCall.invoke();
    assert.equal(result.isError, true, `${invalidCall.toolName} should return error`);

    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    assert.equal(payload.ok, false, `${invalidCall.toolName} should return ok=false`);
    assert.equal(
      payload.error.code,
      "validation_failed",
      `${invalidCall.toolName} should return validation_failed`
    );
    assert.equal(
      Array.isArray(payload.error.details),
      true,
      `${invalidCall.toolName} should include validation details`
    );
  }
});

test("MCP playlist add/remove tools return stable partial contracts", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const addResult = await handlers.playlistAddVideos({
    playlistId: "p1",
    expectedChannelId: "UC_ACTIVE",
    videoIds: ["v1", "v2"],
  });
  const removeResult = await handlers.playlistRemoveVideos({
    playlistId: "p1",
    expectedChannelId: "UC_ACTIVE",
    videoIds: ["v1", "v2"],
  });

  assert.equal(addResult.isError, undefined);
  assert.equal(removeResult.isError, undefined);

  assert.deepEqual(addResult.structuredContent, {
    playlistId: "p1",
    attempted: 2,
    added: 1,
    failures: [{ videoId: "v2", reason: "already-present" }],
  });

  assert.deepEqual(removeResult.structuredContent, {
    playlistId: "p1",
    requested: 2,
    removed: 1,
    failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
  });
});

test("MCP apply returns target-language resolution errors as structured domain errors", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "target_language_unresolvable",
      message:
        "Cannot resolve target language. Set snippet.defaultLanguage on the video or leave exactly one localization.",
      details: { localizationLocales: ["es", "en"] },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "target_language_unresolvable");
});

test("MCP apply returns guardrail mismatch details in structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP apply returns unresolved guardrail details in structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_EXPECTED",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
  });
});

test("MCP playlist_create fails closed on guardrail mismatch with stable details", async () => {
  const core = makeCoreStub();
  core.createPlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistCreate({
    title: "Roadtrip",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP playlist_update fails closed on guardrail mismatch with stable details", async () => {
  const core = makeCoreStub();
  core.updatePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-update",
    expectedChannelId: "UC_EXPECTED",
    title: "Updated",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP playlist_update fails closed on invalid ownership with structured error details", async () => {
  const core = makeCoreStub();
  core.updatePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "Playlist does not belong to the active write channel",
      details: {
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannelId: "UC_OTHER",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-update",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.match(payload.error.message, /does not belong to the active write channel/);
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_ACTIVE",
    activeWriteChannelId: "UC_OTHER",
  });
});

test("MCP playlist_delete fails closed on unresolved channel with stable details", async () => {
  const core = makeCoreStub();
  core.deletePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistDelete({
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_ACTIVE",
  });
});

// Independent test-suite audit (2026-09-26): playlist_add_videos/playlist_remove_videos gained
// the same expectedChannelId write-channel guardrail playlist_update/playlist_delete already
// have (services.ts commit b8d1578), but had no dedicated guardrail-failure test of their own at
// the MCP layer -- only a generic combined validation-failure case that never actually reaches
// the guardrail. Mirrors playlist_update's/playlist_delete's own tests immediately above.
test("MCP playlist_add_videos fails closed on guardrail mismatch with stable details", async () => {
  const core = makeCoreStub();
  core.addVideosToPlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "Playlist does not belong to the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistAddVideos({
    playlistId: "p-add",
    expectedChannelId: "UC_EXPECTED",
    videoIds: ["v1"],
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP playlist_remove_videos fails closed on unresolved channel with stable details", async () => {
  const core = makeCoreStub();
  core.removeVideosFromPlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistRemoveVideos({
    playlistId: "p-remove",
    expectedChannelId: "UC_ACTIVE",
    videoIds: ["v1"],
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_ACTIVE",
  });
});

// Phase 7 slice 1 (docs/roadmap/plans/PHASE_7_PLAN.md): changeset_list, changeset_get,
// localization_import_preview, batch_list, batch_get. All five are read/propose-only --
// no test here needs device-lock setup, since none of them are wrapped by
// wrapMcpHandlersWithMutationGate's assertMcpDeviceAvailable() gate.

function makeChangeSet(overrides: Partial<import("@/lib/changesets/contracts").ChangeSet> = {}) {
  return {
    id: "cs-1",
    channelId: "UC_1",
    source: "xlsx_import" as const,
    status: "in_review" as const,
    importedFilename: "export.xlsx",
    schemaVersion: "1",
    exportedAt: "2026-09-01T00:00:00.000Z",
    hasInvalid: false,
    hasConflicts: false,
    totalChanges: 1,
    pendingCount: 1,
    approvedCount: 0,
    rejectedCount: 0,
    conflictCount: 0,
    invalidCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChange(overrides: Partial<import("@/lib/changesets/contracts").Change> = {}) {
  return {
    id: "chg-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title" as const,
    baselineValue: "Before",
    proposedValue: "After",
    changeType: "modify" as const,
    validationStatus: "valid" as const,
    validationError: null,
    conflictStatus: "none" as const,
    approvalStatus: "pending" as const,
    approvedValue: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBatch(overrides: Partial<import("@/lib/batches/contracts").Batch> = {}) {
  return {
    id: "batch-1",
    channelId: "UC_1",
    status: "PENDING" as const,
    concurrency: 1,
    dryRun: true,
    runId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeLedgerRow(overrides: Partial<import("@/lib/batches/contracts").LedgerRow> = {}) {
  return {
    id: "row-1",
    batchId: "batch-1",
    videoId: "v1",
    changeIds: ["chg-1"],
    status: "PENDING" as const,
    error: null,
    verificationResult: null,
    activeAttemptId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeOperationsCoreStub(): Pick<
  ChangeSetCore,
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport"
> &
  Pick<BatchCore, "listBatchesByChannel" | "getBatchWithLedgerRows"> {
  return {
    listChangeSets: async () => [makeChangeSet()],
    getChangeSet: async () => ({
      changeSet: makeChangeSet(),
      changes: [makeChange()],
      pagination: { page: 1, pageSize: 50, total: 1 },
    }),
    createChangeSetFromImport: async () => ({
      changeSet: makeChangeSet(),
      summary: {
        videosFound: 1,
        localizationRows: 1,
        validChanges: 1,
        unchangedValues: 0,
        invalidRows: 0,
        conflicts: 0,
      },
      errors: [],
      totalErrors: 0,
    }),
    previewImport: async () => ({
      summary: {
        videosFound: 1,
        localizationRows: 1,
        validChanges: 1,
        unchangedValues: 0,
        invalidRows: 0,
        conflicts: 0,
      },
      errors: [],
      totalErrors: 0,
    }),
    listBatchesByChannel: async () => [makeBatch()],
    getBatchWithLedgerRows: async () => ({ batch: makeBatch(), ledgerRows: [makeLedgerRow()] }),
  };
}

// Permissive by default -- these existing tests exercise pre-existing behaviors
// (validation, DomainError propagation, requireBatchForChannel ownership) unrelated to the
// active-channel read-scoping check itself (RISK-02, docs/decisions/0004). Dedicated
// CHANNEL_NOT_ACTIVE tests below use a restrictive stub instead.
function makeChannelAccessCoreStub(): Pick<
  ChannelAccessCore,
  "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
> {
  return {
    assertActiveChannel: async (args: { channelId: string }) => args.channelId,
    getActiveChannelId: async () => "UC_1",
    filterToActiveChannel: (items) => [...items],
    activateChannel: async () => undefined,
  };
}

test("MCP changeset_list returns change sets for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSets.length, 1);
  assert.equal(payload.changeSets[0].id, "cs-1");
});

test("MCP changeset_list rejects a missing channelId before calling the core", async () => {
  let called = false;
  const operationsCore = makeOperationsCoreStub();
  operationsCore.listChangeSets = async () => {
    called = true;
    return [];
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
  const result = await handlers.changesetList({});

  assert.equal(result.isError, true);
  assert.equal(called, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP changeset_get returns a change set with its changes", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetGet({ channelId: "UC_1", changeSetId: "cs-1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSet.id, "cs-1");
  assert.equal(payload.changes.length, 1);
});

test("MCP changeset_get propagates a not_found DomainError unchanged", async () => {
  const operationsCore = makeOperationsCoreStub();
  operationsCore.getChangeSet = async () => {
    throw new DomainError({
      code: "not_found",
      message: "Change Set not found for this channel",
      details: { changeSetId: "missing" },
    });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetGet({ channelId: "UC_1", changeSetId: "missing" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "not_found");
  assert.deepEqual(payload.error.details, { changeSetId: "missing" });
});

test("MCP localization_import_preview decodes base64 and forwards the exact bytes to previewImport", async () => {
  const original = "title,description\nHello,World\n";
  const fileBase64 = Buffer.from(original, "utf8").toString("base64");

  const captured: { buffer?: Buffer } = {};
  const operationsCore = makeOperationsCoreStub();
  operationsCore.previewImport = async (input: unknown) => {
    captured.buffer = (input as { buffer: Buffer }).buffer;
    return {
      summary: { videosFound: 0, localizationRows: 0, validChanges: 0, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.localizationImportPreview({
    channelId: "UC_1",
    filename: "export.xlsx",
    fileBase64,
  });

  assert.equal(result.isError, undefined);
  assert.ok(captured.buffer);
  assert.equal(captured.buffer?.toString("utf8"), original);
});

test("MCP localization_import_preview rejects input missing fileBase64", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
  const result = await handlers.localizationImportPreview({
    channelId: "UC_1",
    filename: "export.xlsx",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP batch_list returns batches for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.batches.length, 1);
  assert.equal(payload.batches[0].id, "batch-1");
});

test("MCP batch_get reads through the ownership-checked getBatchWithLedgerRows (channel + batch), not a bare getBatch", async () => {
  const seenArgs: unknown[] = [];
  const operationsCore = makeOperationsCoreStub();
  operationsCore.getBatchWithLedgerRows = async (channelId: string, batchId: string) => {
    seenArgs.push([channelId, batchId]);
    return { batch: makeBatch(), ledgerRows: [makeLedgerRow()] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_1", batchId: "batch-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [["UC_1", "batch-1"]]);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.batch.id, "batch-1");
  assert.equal(payload.ledgerRows.length, 1);
});

test("MCP batch_get fails closed when the batch does not belong to the given channel", async () => {
  const operationsCore = makeOperationsCoreStub();
  operationsCore.getBatchWithLedgerRows = async () => {
    throw new DomainError({
      code: "not_found",
      message: "Batch does not belong to this channel",
      details: { batchId: "batch-1" },
    });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_OTHER", batchId: "batch-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "not_found");
});

// Owner's requirement (2026-09-20, docs/decisions/0004): every channel-scoped read must be
// rejected when the requested channelId is not this session's active channel.
function makeInactiveChannelAccessCoreStub(): Pick<
  ChannelAccessCore,
  "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
> {
  return {
    assertActiveChannel: async (args: { channelId: string }) => {
      throw new DomainError({
        code: "CHANNEL_NOT_ACTIVE",
        message: "The requested channel is not this session's currently active channel.",
        details: { channelId: args.channelId, activeChannelId: null },
      });
    },
    getActiveChannelId: async () => null,
    filterToActiveChannel: () => [],
    activateChannel: async () => undefined,
  };
}

test("MCP changeset_list rejects a channelId that is not the caller's active channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeInactiveChannelAccessCoreStub()
  );
  const result = await handlers.changesetList({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP batch_get rejects a channelId that is not the caller's active channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeInactiveChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_1", batchId: "batch-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

// BL-008 (docs/roadmap/BACKLOG.md): channel_sync, channel_list, channel_video_list.
// channel_sync writes to the local channels/videos tables, so -- unlike the Phase 7
// slice 1 tools above -- it IS wrapped by the device-availability mutation gate;
// channel_list/channel_video_list are pure reads and are not.

function makeSyncedChannel(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "UC_1",
    title: "Channel 1",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_1",
    connectedUserId: "active-user",
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastSyncedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChannelSyncCoreStub(): Pick<
  ChannelSyncCore,
  "syncChannel" | "listChannels" | "listSyncedVideos"
> {
  return {
    syncChannel: async () => ({
      channel: makeSyncedChannel(),
      videoCount: 1,
      syncedAt: "2026-09-01T00:00:00.000Z",
    }),
    listChannels: async () => ({ channels: [makeSyncedChannel()] }),
    listSyncedVideos: async () => ({ channelId: "UC_1", videos: [] }),
  };
}

test("MCP channel_sync forwards the resolved credentialRef and channelId", async () => {
  const seenArgs: unknown[] = [];
  const channelSyncCore = makeChannelSyncCoreStub();
  channelSyncCore.syncChannel = async (input: unknown) => {
    seenArgs.push(input);
    return { channel: makeSyncedChannel(), videoCount: 1, syncedAt: "2026-09-01T00:00:00.000Z" };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    { ...makeOperationsCoreStub() },
    channelSyncCore
  );
  const result = await handlers.channelSync({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP channel_list returns locally synchronized channels", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    makeChannelSyncCoreStub()
  );
  const result = await handlers.channelList({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channels.length, 1);
  assert.equal(payload.channels[0].channelId, "UC_1");
});

test("MCP channel_video_list returns synced videos for a channel", async () => {
  const channelSyncCore = makeChannelSyncCoreStub();
  channelSyncCore.listSyncedVideos = async () => ({
    channelId: "UC_1",
    videos: [
      {
        videoId: "v1",
        channelId: "UC_1",
        title: "Video 1",
        description: "Desc",
        publishedAt: "2026-09-01T00:00:00.000Z",
        privacyStatus: "private",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        existingLocalizationLanguages: [],
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        etag: null,
        viewCount: null,
        commentCount: null,
        likeCount: null,
        publishAt: null,
      },
    ],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    channelSyncCore
  );
  const result = await handlers.channelVideoList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].videoId, "v1");
});

test("MCP channel_video_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    makeChannelSyncCoreStub()
  );
  const result = await handlers.channelVideoList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP channel_sync is rejected while the operation lock is held; channel_list is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      makeChannelSyncCoreStub()
    );

    const syncResult = await handlers.channelSync({});
    assert.equal(syncResult.isError, true);
    const syncBody = JSON.parse(syncResult.content[0]?.text ?? "{}");
    assert.equal(syncBody.error.code, "operation_lock_held");

    const listResult = await handlers.channelList({});
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Correction to an earlier (wrong) answer given to the project owner: creating a Change
// Set from an import is local-only persistence, the same risk tier as
// localization_import_preview, NOT blocked by Gate B (which only concerns real YouTube
// writes). It DOES mutate local state, though, so it is gated like channel_sync --
// unlike localization_import_preview, which is not.

test("MCP changeset_create_from_import decodes base64 and persists via createChangeSetFromImport", async () => {
  const original = "title,description\nHello,World\n";
  const fileBase64 = Buffer.from(original, "utf8").toString("base64");

  const captured: { buffer?: Buffer } = {};
  const operationsCore = makeOperationsCoreStub();
  operationsCore.createChangeSetFromImport = async (input: unknown) => {
    captured.buffer = (input as { buffer: Buffer }).buffer;
    return {
      changeSet: makeChangeSet(),
      summary: { videosFound: 1, localizationRows: 1, validChanges: 1, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetCreateFromImport({
    channelId: "UC_1",
    filename: "export.xlsx",
    fileBase64,
  });

  assert.equal(result.isError, undefined);
  assert.equal(captured.buffer?.toString("utf8"), original);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSet.id, "cs-1");
});

test("MCP changeset_create_from_import is rejected while the operation lock is held; changeset_list is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub()
    );

    const createResult = await handlers.changesetCreateFromImport({
      channelId: "UC_1",
      filename: "export.xlsx",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    assert.equal(createResult.isError, true);
    const createBody = JSON.parse(createResult.content[0]?.text ?? "{}");
    assert.equal(createBody.error.code, "operation_lock_held");

    const listResult = await handlers.changesetList({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 8 follow-up (docs/roadmap/BACKLOG.md, "machine-readable analytics for operational agents
// to consume") -- analytics_list/analytics_overview. Both are pure reads (analytics_list local,
// analytics_overview a live Analytics API call), so neither is wrapped by the device-availability
// mutation gate, mirroring channel_list/channel_video_list above.

function makeWeeklyReportSummaryFixture() {
  return {
    channelId: "UC_1",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    status: "final",
    generatedAt: "2026-09-21T12:05:00.000Z",
    report: {
      reportFormatVersion: 1,
      channelId: "UC_1",
      weekStartDate: "2026-09-14",
      weekEndDate: "2026-09-20",
      generatedAt: "2026-09-21T12:05:00.000Z",
      status: "final" as const,
      source: "local video_metrics_daily rows for currently-synced videos -- no live YouTube API call" as const,
      metricDefinitions: { views: "Sum of views." },
      syncedVideoTotals: { views: 100, estimatedMinutesWatched: 200, subscribersGained: 3, subscribersLost: 1 },
      previousWeekTotals: { views: 50, estimatedMinutesWatched: 100, subscribersGained: 1, subscribersLost: 0 },
      percentChange: { views: 100, estimatedMinutesWatched: 100, subscribersGained: 200, subscribersLost: null },
      currentWeekDataQuality: { coveredDates: ["2026-09-14"], uncoveredDates: [], tooRecentDates: [], videosWithSkips: [] },
      previousWeekDataQuality: { coveredDates: ["2026-09-07"], uncoveredDates: [], tooRecentDates: [], videosWithSkips: [] },
      topContent: [{ videoId: "v1", title: "Video 1", views: 100 }],
    },
  };
}

function makeAnalyticsCoreStub(): Pick<
  AnalyticsCore,
  | "listMetrics"
  | "getChannelOverview"
  | "getDataQualityReport"
  | "getComparableAgeComparison"
  | "listWeeklyReports"
  | "getWeeklyReport"
  | "listVideoMilestones"
  | "listStoredBreakdowns"
> {
  return {
    listVideoMilestones: async () => ({ channelId: "UC_1", milestones: [] }),
    listStoredBreakdowns: async () => ({ channelId: "UC_1", startDate: "2026-10-01", endDate: "2026-10-02", groupBy: "total", channel: undefined }),
    listMetrics: async () => ({
      channelId: "UC_1",
      rows: [{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 }],
    }),
    getChannelOverview: async () => ({
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      previousStartDate: "2026-07-29",
      previousEndDate: "2026-08-25",
      daily: [{ date: "2026-08-26", views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 }],
      currentTotals: { views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 },
      previousTotals: { views: 5, estimatedMinutesWatched: 10, subscribersGained: 0, subscribersLost: 0 },
      viewCountingChangeInComparison: false,
    }),
    getDataQualityReport: async () => ({
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      coveredDates: ["2026-09-01", "2026-09-02"],
      uncoveredDates: ["2026-09-03", "2026-09-04", "2026-09-05"],
      tooRecentDates: [],
      videosWithSkips: [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-05T00:00:00.000Z", lastSkippedRange: { startDate: "2026-09-01", endDate: "2026-09-04" } }],
    }),
    getComparableAgeComparison: async () => ({
      channelId: "UC_1",
      metricName: "views",
      maxDays: 30,
      videos: [
        {
          videoId: "v1",
          title: "Video 1",
          publishedAt: "2026-09-01T00:00:00.000Z",
          publishDatePacific: "2026-08-31",
          points: [{ dayOffset: 0, value: 10 }],
          cumulativePoints: [{ dayOffset: 0, cumulativeValue: 10 }],
        },
      ],
    }),
    listWeeklyReports: async () => ({ channelId: "UC_1", reports: [makeWeeklyReportSummaryFixture()] }),
    getWeeklyReport: async () => ({ channelId: "UC_1", report: makeWeeklyReportSummaryFixture() }),
  };
}

test("MCP analytics_list forwards the resolved credentialRef and returns locally-collected rows", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listMetrics = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", rows: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP analytics_list forwards optional startDate/endDate/videoId/metricNames filters unchanged", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listMetrics = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", rows: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsList({
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-20",
    videoId: "v1",
    metricNames: ["views"],
  });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-20",
      videoId: "v1",
      metricNames: ["views"],
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_overview returns channel-level cards/chart data for a date range", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsOverview({
    channelId: "UC_1",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.currentTotals.views, 10);
  assert.equal(payload.previousStartDate, "2026-07-29");
});

test("MCP analytics_overview forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getChannelOverview = async (input: unknown) => {
    seenArgs.push(input);
    return {
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      previousStartDate: "2026-07-29",
      previousEndDate: "2026-08-25",
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      viewCountingChangeInComparison: false,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsOverview({ channelId: "UC_1", startDate: "2026-08-26", endDate: "2026-09-22" });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_overview propagates a validation_failed DomainError unchanged (e.g. an inverted date range)", async () => {
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getChannelOverview = async () => {
    throw new DomainError({ code: "validation_failed", message: "period: endDate is before startDate" });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsOverview({
    channelId: "UC_1",
    startDate: "2026-09-22",
    endDate: "2026-08-26",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_list/analytics_overview are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      makeAnalyticsCoreStub()
    );

    const listResult = await handlers.analyticsList({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);

    const overviewResult = await handlers.analyticsOverview({
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
    });
    assert.notEqual(overviewResult.isError, true);

    const dataQualityResult = await handlers.analyticsDataQuality({
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
    });
    assert.notEqual(dataQualityResult.isError, true);

    const comparableAgeResult = await handlers.analyticsComparableAge({
      channelId: "UC_1",
      videoIds: ["v1", "v2"],
    });
    assert.notEqual(comparableAgeResult.isError, true);

    const weeklyReportsListResult = await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });
    assert.notEqual(weeklyReportsListResult.isError, true);

    const weeklyReportGetResult = await handlers.analyticsWeeklyReportGet({
      channelId: "UC_1",
      weekStartDate: "2026-09-14",
    });
    assert.notEqual(weeklyReportGetResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP analytics_data_quality returns coverage/skip diagnostics for a date range", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsDataQuality({
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.coveredDates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(payload.videosWithSkips, [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-05T00:00:00.000Z", lastSkippedRange: { startDate: "2026-09-01", endDate: "2026-09-04" } }]);
});

test("MCP analytics_data_quality forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getDataQualityReport = async (input: unknown) => {
    seenArgs.push(input);
    return {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      coveredDates: [],
      uncoveredDates: [],
      tooRecentDates: [],
      videosWithSkips: [],
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsDataQuality({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-05" });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_data_quality rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsDataQuality({ startDate: "2026-09-01", endDate: "2026-09-05" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_comparable_age returns per-video day-since-publish series for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1", "v2"] });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.metricName, "views");
  assert.deepEqual(payload.videos[0].points, [{ dayOffset: 0, value: 10 }]);
});

test("MCP analytics_comparable_age forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getComparableAgeComparison = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", metricName: "views", maxDays: 30, videos: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1", "v2"] });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      videoIds: ["v1", "v2"],
      metricName: "views",
      maxDays: 30,
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_comparable_age rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ videoIds: ["v1", "v2"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_comparable_age rejects fewer than 2 videoIds", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_weekly_reports_list returns stored snapshot summaries for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.reports[0].weekStartDate, "2026-09-14");
  assert.equal(payload.reports[0].status, "final");
});

test("MCP analytics_weekly_reports_list forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listWeeklyReports = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", reports: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });

  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP analytics_weekly_reports_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportsList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_weekly_report_get returns null report when none exists for the requested week", async () => {
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getWeeklyReport = async () => ({ channelId: "UC_1", report: null });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsWeeklyReportGet({ channelId: "UC_1", weekStartDate: "2026-09-14" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.report, null);
});

test("MCP analytics_weekly_report_get rejects a missing weekStartDate", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportGet({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

function makeAiLocalizationCoreStub(
  captureCreateChangeSetCallOrigin?: (callOrigin: unknown) => void
): Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration"> {
  return {
    generateProposals: async () => ({
      results: [
        {
          videoId: "v1",
          language: "es",
          providerError: null,
          fields: [
            {
              videoId: "v1",
              language: "es",
              field: "title",
              baselineValue: "Old title",
              proposedValue: "Nuevo titulo",
              changeType: "modify",
              validationStatus: "valid",
              validationError: null,
            },
          ],
          usage: null,
        },
      ],
      errors: [],
      summary: {
        targetsRequested: 1,
        targetsGenerated: 1,
        targetsFailed: 0,
        validProposals: 1,
        invalidProposals: 0,
        unchangedProposals: 0,
      },
      generationContext: { profileVersion: null, effectiveContext: null },
    }),
    createChangeSetFromGeneration: async (_input, callOrigin) => {
      captureCreateChangeSetCallOrigin?.(callOrigin);
      return makeChangeSet({ source: "ai_localization" });
    },
  };
}

test("MCP ai_localization_generate forwards input and checks active-channel access", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({
    channelId: "UC_1",
    videoIds: ["v1"],
    targetLanguages: ["es"],
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.results[0].videoId, "v1");
  assert.equal(payload.summary.validProposals, 1);
});

test("MCP ai_localization_generate rejects a channelId that is not the caller's active channel", async () => {
  const restrictiveChannelAccess: Pick<
    ChannelAccessCore,
    "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
  > = {
    async assertActiveChannel() {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    async getActiveChannelId() {
      return null;
    },
    filterToActiveChannel(items) {
      return [...items];
    },
    async activateChannel() {},
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    restrictiveChannelAccess,
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({
    channelId: "UC_OTHER",
    videoIds: ["v1"],
    targetLanguages: ["es"],
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP ai_localization_generate rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({ videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP ai_localization_create_change_set persists via createChangeSetFromGeneration, source ai_localization", async () => {
  let capturedCallOrigin: unknown;
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub((callOrigin) => {
      capturedCallOrigin = callOrigin;
    })
  );
  const result = await handlers.aiLocalizationCreateChangeSet({
    channelId: "UC_1",
    proposals: [{ videoId: "v1", language: "es", title: "Nuevo titulo" }],
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.source, "ai_localization");
  // Phase 7 slice F (owner spec §22): the MCP transport must SERVER-STAMP its own identity --
  // never left to default to "web_ui", and never taken from the caller's input.
  assert.deepEqual(capturedCallOrigin, { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION });
});

test("MCP ai_localization_create_change_set is rejected while the operation lock is held; ai_localization_generate is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      makeAiLocalizationCoreStub()
    );

    const generateResult = await handlers.aiLocalizationGenerate({
      channelId: "UC_1",
      videoIds: ["v1"],
      targetLanguages: ["es"],
    });
    assert.equal(generateResult.isError, undefined);

    const createResult = await handlers.aiLocalizationCreateChangeSet({
      channelId: "UC_1",
      proposals: [{ videoId: "v1", language: "es", title: "Nuevo titulo" }],
    });
    assert.equal(createResult.isError, true);
    const payload = JSON.parse(createResult.content[0]?.text ?? "{}");
    assert.equal(payload.error.code, "operation_lock_held");
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP ai_localization_create_change_set rejects an empty proposals array", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationCreateChangeSet({ channelId: "UC_1", proposals: [] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_capabilities returns version/capabilities/permission-model with no channel scoping required", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined
  );
  const result = await handlers.agentGetCapabilities({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  // Bumped 0.13.0 -> 0.14.0, Phase 10 slice 2: new decision_engine capabilities added.
  // Bumped 0.14.0 -> 0.15.0, Phase 11: new channel_workspace.get_channel_workspace capability
  // (docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-11).
  // Bumped 0.15.0 -> 1.0.0, Phase 12 (AC-P12-13): breaking agent-contract change -> MAJOR.
  assert.equal(payload.agentApiVersion, "3.11.0"); // MINOR 3.11.0 (BL-169, VIDEO_SEARCH_TERMS_PLAN.md §2): new READ capability analytics.query_stored_search_terms; MINOR 3.10.0 (BL-168, VIDEO_BREAKDOWNS_PLAN.md §2 "Reads"): new READ capability analytics.query_stored_breakdowns; MINOR 3.9.0 (BL-166, VIDEO_MILESTONES_PLAN.md §2 "Versions"): new READ capability analytics.query_video_milestones; MINOR 3.6.0 (BL-135): agent_release_media_session + releaseWhenDone; MINOR 3.5.0 (BL-132): media template input parameters (image/audio/video), job inputs[], template source/models; before that 3.3.0 (Factory Operator access, logical path registry tools) on top of 3.2.0 + MINOR 3.4.0: the seven media_generation capabilities (Phase 14 slice 5) and agent_get_media_limits openSessions/maxConcurrentSessions/activeSessionCount (slice 6)
  assert.ok(
    payload.capabilities.some(
      (c: { id: string; permission: string }) => c.id === "channel_workspace.get_channel_workspace" && c.permission === "READ"
    )
  );
  assert.deepEqual(payload.grantedPermissions, ["READ", "DRAFT"]);
  assert.ok(payload.capabilities.some((c: { id: string }) => c.id === "system.get_capabilities"));
});

test("MCP agent_get_capabilities rejects an unexpected input field", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined
  );
  const result = await handlers.agentGetCapabilities({ unexpected: true });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_capabilities is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined
    );
    const result = await handlers.agentGetCapabilities({});
    assert.notEqual(result.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

function makeAgentOperationsCoreStub(): Pick<
  AgentOperationsCore,
  | "getSystemCapabilities"
  | "getChannelContext"
  | "getVideoContext"
  | "queryChannelAnalytics"
  | "queryVideoAnalytics"
  | "listAssets"
  | "getAssetContext"
  | "getGenerationProvenance"
  | "createContentProposal"
  | "getContentProposal"
  | "listContentProposals"
  | "registerExternalArtifact"
  | "listProposalArtifacts"
  | "operationsWorkspaceListFiles"
  | "operationsWorkspaceGetFile"
  | "findComparableVideos"
  | "listAssetPerformance"
> {
  return {
    getSystemCapabilities: async () => ({
      productVersion: "9.9.9",
      agentApiVersion: "0.1.0",
      capabilities: [],
      dataDomains: [],
      actionClasses: ["READ", "DRAFT", "APPROVE", "EXECUTE"],
      grantedPermissions: ["READ", "DRAFT"],
      // "create_experiment_proposal" moved to a real capability (Phase 10 slice 2); this fixture
      // just needs a value matching the current PlannedFutureCapability type, not this specific one.
      plannedFutureCapabilities: ["create_hypothesis"],
      schemaVersions: { app: 14 },
    }),
    getChannelContext: async () => ({
      channelId: "UC_1",
      title: "Test Channel",
      lastSyncedAt: "2026-09-20T00:00:00.000Z",
      syncedVideoCount: 5,
      editorialProfile: null,
      trackedLanguages: ["es"],
    }),
    getVideoContext: async () => ({
      videoId: "v1",
      channelId: "UC_1",
      includedSections: ["metadata", "localizations"],
      metadata: {
        videoId: "v1",
        channelId: "UC_1",
        title: "Title",
        description: "Description",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        lastSyncedAt: "2026-09-20T00:00:00.000Z",
        durationSeconds: 7200,
        liveBroadcastContent: "none",
      },
      localizations: [],
    }),
    queryChannelAnalytics: async () => ({
      channelId: "UC_1",
      period: { startDate: "2026-09-01", endDate: "2026-09-07", previousStartDate: "2026-08-25", previousEndDate: "2026-08-31" },
      filters: {},
      metricDefinitions: [{ name: "views", description: "Number of times the video was viewed.", unit: "count" }],
      freshness: { source: "live_youtube_analytics_api", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      viewCountingChangeInComparison: false,
    }),
    queryVideoAnalytics: async () => ({
      channelId: "UC_1",
      period: { startDate: null, endDate: null },
      filters: { videoId: null, metricNames: null },
      metricDefinitions: [{ name: "views", description: "Number of times the video was viewed.", unit: "count" }],
      freshness: { source: "local_collected_data", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      rows: [],
    }),
    listAssets: async () => ({ assets: [] }),
    getAssetContext: async () => ({
      assetId: "asset-1",
      channelId: "UC_1",
      assetType: "thumbnail",
      referenceKind: "url",
      referenceValue: "https://example.com/a.png",
      title: null,
      description: null,
      linkedVideoId: null,
      provenance: null,
      createdAt: "2026-09-24T00:00:00.000Z",
    }),
    getGenerationProvenance: async () => ({
      profileVersion: 1,
      effectiveContext: null,
      changeSetId: "cs-1",
      channelId: "UC_1",
      createdAt: "2026-09-24T00:00:00.000Z",
      evidence: null,
      rationale: null,
      createdVia: null,
      agentApiVersion: null,
    }),
    createContentProposal: async () => ({
      proposalId: "proposal-1",
      channelId: "UC_1",
      objective: null,
      topicConcept: null,
      rationale: null,
      evidence: null,
      brief: null,
      referenceVideoIds: null,
      referenceAssetIds: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "mcp",
      agentApiVersion: "0.1.0",
    }),
    getContentProposal: async () => ({
      proposalId: "proposal-1",
      channelId: "UC_1",
      objective: null,
      topicConcept: null,
      rationale: null,
      evidence: null,
      brief: null,
      referenceVideoIds: null,
      referenceAssetIds: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "web_ui",
      agentApiVersion: null,
    }),
    listContentProposals: async () => ({ proposals: [] }),
    registerExternalArtifact: async () => ({
      linkId: "link-1",
      proposalId: "proposal-1",
      channelId: "UC_1",
      asset: {
        assetId: "asset-1",
        channelId: "UC_1",
        assetType: "thumbnail",
        referenceKind: "url",
        referenceValue: "https://example.com/a.png",
        title: null,
        description: null,
        linkedVideoId: null,
        provenance: null,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "mcp",
      agentApiVersion: AGENT_API_VERSION,
    }),
    listProposalArtifacts: async () => ({ artifacts: [] }),
    operationsWorkspaceListFiles: async () => ({ configured: false }),
    operationsWorkspaceGetFile: async () => ({ configured: false }),
    findComparableVideos: async () => ({
      anchorVideoId: "v1",
      anchor: { videoId: "v1", title: "Anchor", publishedAt: "2026-05-01T20:00:00.000Z", durationSeconds: null, performanceMetricValue: null },
      performanceAlignment: null,
      candidates: [],
      excludedForMissingData: { duration: 0, performance: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    }),
    listAssetPerformance: async () => ({
      assets: [],
      performanceAlignment: null,
      excludedForMissingLink: { unlinked: 0, linkedVideoNotOnChannel: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    }),
  };
}

test("MCP agent_get_channel_context forwards input and checks active-channel access", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentGetChannelContext({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channelId, "UC_1");
  assert.equal(payload.syncedVideoCount, 5);
});

function makeRestrictiveChannelAccessStub() {
  return {
    async assertActiveChannel() {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    async getActiveChannelId() {
      return null;
    },
    filterToActiveChannel<T>(items: readonly T[]) {
      return [...items];
    },
    async activateChannel() {},
  };
}

test("MCP agent_get_channel_context rejects a channelId that is not the caller's active channel", async () => {
  // Uses a "must not be called" stub, not the ordinary makeAgentOperationsCoreStub(), so this
  // test proves the service is genuinely never reached on a channel-scoping failure -- not just
  // that the tool call ends in an error.
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    getChannelContext: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetChannelContext({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_video_context forwards input including optional `include`, checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.getVideoContext = async (input: unknown) => {
    captured = input;
    return {
      videoId: "v1",
      channelId: "UC_1",
      includedSections: ["metadata"],
      metadata: {
        videoId: "v1",
        channelId: "UC_1",
        title: "Title",
        description: "Description",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        lastSyncedAt: "2026-09-20T00:00:00.000Z",
        durationSeconds: null,
        liveBroadcastContent: null,
      },
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  await handlers.agentGetVideoContext({ channelId: "UC_1", videoId: "v1", include: ["metadata"] });

  assert.deepEqual(captured, { channelId: "UC_1", videoId: "v1", include: ["metadata"] });
});

test("MCP agent_get_video_context rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    getVideoContext: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetVideoContext({ channelId: "UC_OTHER", videoId: "v1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_video_context rejects a missing videoId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentGetVideoContext({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_channel_context/agent_get_video_context are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const channelResult = await handlers.agentGetChannelContext({ channelId: "UC_1" });
    assert.notEqual(channelResult.isError, true);
    const videoResult = await handlers.agentGetVideoContext({ channelId: "UC_1", videoId: "v1" });
    assert.notEqual(videoResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_query_channel_analytics forwards the resolved credentialRef and the caller's own input unchanged into queryChannelAnalytics", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.queryChannelAnalytics = async (input: unknown) => {
    captured = input;
    return {
      channelId: "UC_1",
      period: { startDate: "2026-09-01", endDate: "2026-09-07", previousStartDate: "2026-08-25", previousEndDate: "2026-08-31" },
      filters: {},
      metricDefinitions: [],
      freshness: { source: "live_youtube_analytics_api", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      viewCountingChangeInComparison: false,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentQueryChannelAnalytics({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    credentialRef: { userId: "active-user" },
  });
});

// BL-114 (ADR 0014): thumbnail impressions/CTR. A local read of already-imported Reporting API data.
function makeReachCoreStub(capture: { input?: unknown }) {
  return {
    async getChannelReach(input: unknown) {
      capture.input = input;
      return {
        channelId: "UC_1",
        state: "waiting_for_first_report" as const,
        jobCreatedAt: "2026-10-01T21:05:54Z",
        coverage: { firstDate: null, lastDate: null, importedFiles: 0 },
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        daily: [],
        videos: [],
        totals: { impressions: 0, ctr: null },
      };
    },
  };
}

test("MCP agent_query_channel_reach forwards the resolved credentialRef and the caller's input unchanged, and returns the explicit state", async () => {
  const capture: { input?: unknown } = {};
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeReachCoreStub(capture)
  );

  const result = await handlers.agentQueryChannelReach({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capture.input, {
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    credentialRef: { userId: "active-user" },
  });
  assert.equal((result.structuredContent as { state?: string } | undefined)?.state, "waiting_for_first_report");
});

test("BL-118: MCP agent_query_channel_breakdown forwards the resolved credentialRef, labels every row, and says the read is live", async () => {
  const capture: { input?: unknown } = {};
  const breakdownStub = {
    async getChannelBreakdown(input: unknown) {
      capture.input = input;
      return {
        channelId: "UC_1",
        breakdown: "trafficSources" as const,
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        rows: [{ dimensionValues: ["YT_SEARCH"], metrics: { views: 120 } }],
      };
    },
  };
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeReachCoreStub({}),
    breakdownStub
  );

  const result = await handlers.agentQueryChannelBreakdown({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07", breakdown: "trafficSources" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capture.input, {
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    breakdown: "trafficSources",
    credentialRef: { userId: "active-user" },
  });
  const payload = result.structuredContent as { rows: Array<{ dimensionValues: string[]; label: string; metrics: Record<string, number> }>; freshness: { source: string } };
  assert.deepEqual(payload.rows[0].dimensionValues, ["YT_SEARCH"], "the raw API value is kept");
  assert.notEqual(payload.rows[0].label, "", "and a readable label is added");
  assert.equal(payload.freshness.source, "live_youtube_analytics_api");
});

test("BL-118: MCP agent_query_channel_breakdown rejects an unknown breakdown kind or extra field without calling the service", async () => {
  let called = false;
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeReachCoreStub({}),
    { async getChannelBreakdown() { called = true; throw new Error("must not be called"); } }
  );
  for (const bad of [
    { channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07", breakdown: "nope" },
    { channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07", breakdown: "deviceType", extra: 1 },
  ]) {
    const result = await handlers.agentQueryChannelBreakdown(bad);
    assert.equal(result.isError, true);
  }
  assert.equal(called, false);
});

test("MCP agent_query_channel_reach rejects a malformed or unknown-field input without calling the service", async () => {
  const capture: { input?: unknown } = {};
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeReachCoreStub(capture)
  );

  for (const bad of [
    { channelId: "UC_1", startDate: "yesterday", endDate: "2026-09-07" },
    { channelId: "UC_1", startDate: "2026-09-01" },
    { startDate: "2026-09-01", endDate: "2026-09-07" },
    { channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07", extra: true },
  ]) {
    const result = await handlers.agentQueryChannelReach(bad);
    assert.equal(result.isError, true, JSON.stringify(bad));
  }
  assert.equal(capture.input, undefined);
});

test("MCP agent_query_video_analytics forwards the resolved credentialRef and optional filters unchanged into queryVideoAnalytics", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.queryVideoAnalytics = async (input: unknown) => {
    captured = input;
    return {
      channelId: "UC_1",
      period: { startDate: null, endDate: null },
      filters: { videoId: "v1", metricNames: ["views"] },
      metricDefinitions: [],
      freshness: { source: "local_collected_data", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      rows: [],
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentQueryVideoAnalytics({ channelId: "UC_1", videoId: "v1", metricNames: ["views"] });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    videoId: "v1",
    metricNames: ["views"],
    credentialRef: { userId: "active-user" },
  });
});

test("MCP agent_query_channel_analytics/agent_query_video_analytics are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const channelResult = await handlers.agentQueryChannelAnalytics({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07" });
    assert.notEqual(channelResult.isError, true);
    const videoResult = await handlers.agentQueryVideoAnalytics({ channelId: "UC_1" });
    assert.notEqual(videoResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_list_assets forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.listAssets = async (input: unknown) => {
    captured = input;
    return { assets: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListAssets({ channelId: "UC_1", assetType: "thumbnail" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1", assetType: "thumbnail" });
});

test("MCP agent_list_assets rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    listAssets: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListAssets({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_asset_context forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.getAssetContext = async (input: unknown) => {
    captured = input;
    return {
      assetId: "asset-1",
      channelId: "UC_1",
      assetType: "thumbnail",
      referenceKind: "url",
      referenceValue: "https://example.com/a.png",
      title: null,
      description: null,
      linkedVideoId: null,
      provenance: null,
      createdAt: "2026-09-24T00:00:00.000Z",
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetAssetContext({ channelId: "UC_1", assetId: "asset-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1", assetId: "asset-1" });
});

test("MCP agent_get_asset_context rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    getAssetContext: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetAssetContext({ channelId: "UC_OTHER", assetId: "asset-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_list_assets/agent_get_asset_context are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const listResult = await handlers.agentListAssets({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);
    const getResult = await handlers.agentGetAssetContext({ channelId: "UC_1", assetId: "asset-1" });
    assert.notEqual(getResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_get_generation_provenance forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.getGenerationProvenance = async (input: unknown) => {
    captured = input;
    return null;
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetGenerationProvenance({ channelId: "UC_1", changeSetId: "cs-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1", changeSetId: "cs-1" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.provenance, null);
});

test("MCP agent_get_generation_provenance rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    getGenerationProvenance: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetGenerationProvenance({ channelId: "UC_OTHER", changeSetId: "cs-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_generation_provenance is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const result = await handlers.agentGetGenerationProvenance({ channelId: "UC_1", changeSetId: "cs-1" });
    assert.notEqual(result.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_create_content_proposal forwards input, checks active-channel access, and stamps mcp identity", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let capturedInput: unknown;
  let capturedCallOrigin: unknown;
  agentOperationsCore.createContentProposal = async (input: unknown, callOrigin: unknown) => {
    capturedInput = input;
    capturedCallOrigin = callOrigin;
    return {
      proposalId: "proposal-1",
      channelId: "UC_1",
      objective: "Grow",
      topicConcept: null,
      rationale: null,
      evidence: null,
      brief: null,
      referenceVideoIds: null,
      referenceAssetIds: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "mcp",
      agentApiVersion: AGENT_API_VERSION,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentCreateContentProposal({ channelId: "UC_1", objective: "Grow" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, { channelId: "UC_1", objective: "Grow" });
  // Phase 7 slice G (owner spec §22): the MCP transport must SERVER-STAMP its own identity --
  // never left to default, and never taken from the caller's input.
  assert.deepEqual(capturedCallOrigin, { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.proposalId, "proposal-1");
});

test("MCP agent_create_content_proposal rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    createContentProposal: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentCreateContentProposal({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_create_content_proposal is rejected while the operation lock is held; agent_get_content_proposal/agent_list_content_proposals are not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const createResult = await handlers.agentCreateContentProposal({ channelId: "UC_1" });
    assert.equal(createResult.isError, true);

    const getResult = await handlers.agentGetContentProposal({ channelId: "UC_1", proposalId: "proposal-1" });
    assert.notEqual(getResult.isError, true);

    const listResult = await handlers.agentListContentProposals({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_get_content_proposal forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.getContentProposal = async (input: unknown) => {
    captured = input;
    return {
      proposalId: "proposal-1",
      channelId: "UC_1",
      objective: null,
      topicConcept: null,
      rationale: null,
      evidence: null,
      brief: null,
      referenceVideoIds: null,
      referenceAssetIds: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "web_ui",
      agentApiVersion: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetContentProposal({ channelId: "UC_1", proposalId: "proposal-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1", proposalId: "proposal-1" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.proposalId, "proposal-1");
});

test("MCP agent_get_content_proposal rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    getContentProposal: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetContentProposal({ channelId: "UC_OTHER", proposalId: "proposal-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_list_content_proposals forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.listContentProposals = async (input: unknown) => {
    captured = input;
    return { proposals: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListContentProposals({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.proposals, []);
});

test("MCP agent_list_content_proposals rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    listContentProposals: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListContentProposals({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_register_external_artifact forwards input, checks active-channel access, and stamps mcp identity", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let capturedInput: unknown;
  let capturedCallOrigin: unknown;
  agentOperationsCore.registerExternalArtifact = async (input: unknown, callOrigin: unknown) => {
    capturedInput = input;
    capturedCallOrigin = callOrigin;
    return {
      linkId: "link-1",
      proposalId: "proposal-1",
      channelId: "UC_1",
      asset: {
        assetId: "asset-1",
        channelId: "UC_1",
        assetType: "thumbnail",
        referenceKind: "url",
        referenceValue: "https://example.com/a.png",
        title: null,
        description: null,
        linkedVideoId: null,
        provenance: null,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
      createdAt: "2026-09-24T00:00:00.000Z",
      createdVia: "mcp",
      agentApiVersion: AGENT_API_VERSION,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentRegisterExternalArtifact({
    channelId: "UC_1",
    proposalId: "proposal-1",
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "https://example.com/a.png",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    channelId: "UC_1",
    proposalId: "proposal-1",
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "https://example.com/a.png",
  });
  // Phase 7 slice G2 (owner spec §22): the MCP transport must SERVER-STAMP its own identity.
  assert.deepEqual(capturedCallOrigin, { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.linkId, "link-1");
});

// Owner spec §17: agent-callable registration must never accept `local_path` -- rejected by the
// MCP tool's own schema validation before `agentOperationsCore.registerExternalArtifact` is even
// called (the service layer independently enforces the same restriction, see
// src/lib/content-proposals/services.test.ts).
test("MCP agent_register_external_artifact rejects referenceKind local_path as validation_failed", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let called = false;
  agentOperationsCore.registerExternalArtifact = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentRegisterExternalArtifact({
    channelId: "UC_1",
    proposalId: "proposal-1",
    assetType: "thumbnail",
    referenceKind: "local_path",
    referenceValue: "/tmp/x.png",
  });

  assert.equal(result.isError, true);
  assert.equal(called, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

// RISK-58 (docs/TECHNICAL_DEBT.md): the `referenceKind: "url"` enum value alone was only a label
// -- an independent review round found the schema originally accepted any non-empty string under
// it, including a filesystem path. This must be rejected at the MCP tool's own schema validation,
// exactly like `local_path` above.
test("MCP agent_register_external_artifact rejects a filesystem path under referenceKind url as validation_failed", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let called = false;
  agentOperationsCore.registerExternalArtifact = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentRegisterExternalArtifact({
    channelId: "UC_1",
    proposalId: "proposal-1",
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "/Users/x/secret",
  });

  assert.equal(result.isError, true);
  assert.equal(called, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_register_external_artifact rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    registerExternalArtifact: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentRegisterExternalArtifact({
    channelId: "UC_OTHER",
    proposalId: "proposal-1",
    assetType: "thumbnail",
    referenceKind: "url",
    referenceValue: "https://example.com/a.png",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_register_external_artifact is rejected while the operation lock is held; agent_list_proposal_artifacts is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const registerResult = await handlers.agentRegisterExternalArtifact({
      channelId: "UC_1",
      proposalId: "proposal-1",
      assetType: "thumbnail",
      referenceKind: "url",
      referenceValue: "https://example.com/a.png",
    });
    assert.equal(registerResult.isError, true);

    const listResult = await handlers.agentListProposalArtifacts({ channelId: "UC_1", proposalId: "proposal-1" });
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_list_proposal_artifacts forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.listProposalArtifacts = async (input: unknown) => {
    captured = input;
    return { artifacts: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListProposalArtifacts({ channelId: "UC_1", proposalId: "proposal-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { channelId: "UC_1", proposalId: "proposal-1" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.artifacts, []);
});

test("MCP agent_list_proposal_artifacts rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    listProposalArtifacts: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListProposalArtifacts({ channelId: "UC_OTHER", proposalId: "proposal-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_list_operations_files forwards its input unchanged, no channel scoping required", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.operationsWorkspaceListFiles = async (input: unknown) => {
    captured = input;
    return { configured: true, files: [{ path: "AGENTS.md", isDirectory: false, sizeBytes: 42 }], truncated: false };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListOperationsFiles({});

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {});
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload, { configured: true, files: [{ path: "AGENTS.md", isDirectory: false, sizeBytes: 42 }], truncated: false });
});

test("MCP agent_list_operations_files rejects an unexpected input field", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentListOperationsFiles({ unexpected: true });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_operations_file forwards its input unchanged, no channel scoping required", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.operationsWorkspaceGetFile = async (input: unknown) => {
    captured = input;
    return { configured: true, path: "AGENTS.md", content: "# hi", truncated: false };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetOperationsFile({ path: "AGENTS.md" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, { path: "AGENTS.md" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload, { configured: true, path: "AGENTS.md", content: "# hi", truncated: false });
});

test("MCP agent_get_operations_file rejects a missing path field", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentGetOperationsFile({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_list_operations_files/agent_get_operations_file are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const listResult = await handlers.agentListOperationsFiles({});
    assert.notEqual(listResult.isError, true);
    const getResult = await handlers.agentGetOperationsFile({ path: "AGENTS.md" });
    assert.notEqual(getResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_find_comparable_videos forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.findComparableVideos = async (input: unknown) => {
    captured = input;
    return {
      anchorVideoId: "v1",
      anchor: { videoId: "v1", title: "Anchor", publishedAt: "2026-05-01T20:00:00.000Z", durationSeconds: null, performanceMetricValue: null },
      performanceAlignment: null,
      candidates: [],
      excludedForMissingData: { duration: 0, performance: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentFindComparableVideos({ channelId: "UC_1", anchorVideoId: "v1", sort: "publicationProximity" });

  assert.equal(result.isError, undefined);
  // credentialRef is always auto-resolved and forwarded (cheap, local identity lookup, same as
  // every other channel-scoped handler already does for its own assertActiveChannel check) --
  // even though this request never actually needed it (no performanceMetric).
  assert.deepEqual(captured, { channelId: "UC_1", anchorVideoId: "v1", sort: "publicationProximity", credentialRef: { userId: "active-user" } });
});

test("MCP agent_find_comparable_videos auto-resolves credentialRef to the caller's own active identity when performanceMetric is requested but no credentialRef was supplied", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.findComparableVideos = async (input: unknown) => {
    captured = input;
    return {
      anchorVideoId: "v1",
      anchor: { videoId: "v1", title: "Anchor", publishedAt: "2026-05-01T20:00:00.000Z", durationSeconds: null, performanceMetricValue: 10 },
      performanceAlignment: { metricName: "views", dayOffset: 5 },
      candidates: [],
      excludedForMissingData: { duration: 0, performance: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentFindComparableVideos({
    channelId: "UC_1",
    anchorVideoId: "v1",
    performanceMetric: "views",
    sort: "performanceMetric",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    anchorVideoId: "v1",
    performanceMetric: "views",
    sort: "performanceMetric",
    credentialRef: { userId: "active-user" },
  });
});

// This capability lets the caller pick which locally-stored identity's credentialRef governs the
// active-channel check, deliberately -- the same as agent_query_channel_analytics/
// agent_query_video_analytics already do for their own downstream calls (no per-user ownership
// boundary exists in this app's security model, docs/TECHNICAL_DEBT.md), unlike
// agent_list_assets/agent_get_asset_context above, which always use the local active identity
// regardless of input (their own schemas don't even accept a credentialRef field).
test("MCP agent_find_comparable_videos uses an explicitly caller-supplied credentialRef for the active-channel check, not just for forwarding", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  agentOperationsCore.findComparableVideos = async () => ({
    anchorVideoId: "v1",
    anchor: { videoId: "v1", title: "Anchor", publishedAt: "2026-05-01T20:00:00.000Z", durationSeconds: null, performanceMetricValue: null },
    performanceAlignment: null,
    candidates: [],
    excludedForMissingData: { duration: 0, performance: 0 },
    truncated: false,
    metricDefinitions: null,
    freshness: null,
  });

  let capturedUserId: string | null = null;
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    {
      assertActiveChannel: async (args) => {
        capturedUserId = args.userId ?? null;
        return args.channelId;
      },
      getActiveChannelId: async () => "UC_1",
      filterToActiveChannel: (items) => [...items],
      activateChannel: async () => undefined,
    } satisfies ChannelAccessCore,
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentFindComparableVideos({
    channelId: "UC_1",
    anchorVideoId: "v1",
    sort: "publicationProximity",
    credentialRef: { userId: "explicit-caller" },
  });

  assert.equal(result.isError, undefined);
  assert.equal(capturedUserId, "explicit-caller");
});

test("MCP agent_find_comparable_videos rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    findComparableVideos: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentFindComparableVideos({ channelId: "UC_OTHER", anchorVideoId: "v1", sort: "publicationProximity" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_find_comparable_videos rejects input that fails its own schema (e.g. missing sort)", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentFindComparableVideos({ channelId: "UC_1", anchorVideoId: "v1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_find_comparable_videos propagates a real domain error thrown by the underlying service (e.g. DATA_NOT_SYNCED for an unknown anchor)", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  agentOperationsCore.findComparableVideos = async () => {
    throw new DomainError({
      code: "DATA_NOT_SYNCED",
      message: "anchorVideoId does not belong to the requested channel",
      details: { channelId: "UC_1", anchorVideoId: "nonexistent" },
    });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentFindComparableVideos({ channelId: "UC_1", anchorVideoId: "nonexistent", sort: "publicationProximity" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "DATA_NOT_SYNCED");
});

test("MCP agent_find_comparable_videos is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const result = await handlers.agentFindComparableVideos({ channelId: "UC_1", anchorVideoId: "v1", sort: "publicationProximity" });
    assert.notEqual(result.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_list_asset_performance forwards input and checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.listAssetPerformance = async (input: unknown) => {
    captured = input;
    return {
      assets: [],
      performanceAlignment: null,
      excludedForMissingLink: { unlinked: 0, linkedVideoNotOnChannel: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListAssetPerformance({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  // credentialRef is always auto-resolved and forwarded, same as agent_find_comparable_videos.
  assert.deepEqual(captured, { channelId: "UC_1", credentialRef: { userId: "active-user" } });
});

test("MCP agent_list_asset_performance auto-resolves credentialRef to the caller's own active identity when performanceMetric is requested but no credentialRef was supplied", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.listAssetPerformance = async (input: unknown) => {
    captured = input;
    return {
      assets: [],
      performanceAlignment: { metricName: "views", dayOffset: 3 },
      excludedForMissingLink: { unlinked: 0, linkedVideoNotOnChannel: 0 },
      truncated: false,
      metricDefinitions: null,
      freshness: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListAssetPerformance({ channelId: "UC_1", performanceMetric: "views", performanceDayOffset: 3 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    performanceMetric: "views",
    performanceDayOffset: 3,
    credentialRef: { userId: "active-user" },
  });
});

test("MCP agent_list_asset_performance rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    | "getSystemCapabilities"
    | "getChannelContext"
    | "getVideoContext"
    | "queryChannelAnalytics"
    | "queryVideoAnalytics"
    | "listAssets"
    | "getAssetContext"
    | "getGenerationProvenance"
    | "createContentProposal"
    | "getContentProposal"
    | "listContentProposals"
    | "registerExternalArtifact"
    | "listProposalArtifacts"
    | "operationsWorkspaceListFiles"
    | "operationsWorkspaceGetFile"
    | "findComparableVideos"
    | "listAssetPerformance"
  > = {
    ...makeAgentOperationsCoreStub(),
    listAssetPerformance: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentListAssetPerformance({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_list_asset_performance rejects input that fails its own schema (e.g. performanceMetric without performanceDayOffset)", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentListAssetPerformance({ channelId: "UC_1", performanceMetric: "views" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_list_asset_performance is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const result = await handlers.agentListAssetPerformance({ channelId: "UC_1" });
    assert.notEqual(result.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 9 slice 4 (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md) -- query_competitors/
// query_market_intelligence, registered directly against marketIntelligenceCore (9th positional
// arg), not agentOperationsCore. See MarketIntelligenceCoreSubset's own doc comment in server.ts
// for why these two are wired this way instead of through agent-operations. Both handlers now
// call the market-intelligence module's own single getWatchlistEntryContext (independent review,
// 2026-09-26: MCP and CLI previously each re-orchestrated getWatchlistEntry+listEvidence
// separately, a duplicated two-call join that had already started to drift cosmetically).
function makeMarketIntelligenceCoreStub(): Pick<
  MarketIntelligenceCore,
  | "listWatchlist"
  | "getWatchlistEntryContext"
  | "listTopics"
  | "listTrendCandidates"
  | "listDiscoveryCandidates"
  | "createMarketResearchRequest"
  | "createCollectionRequest"
  | "listCollectionRequests"
  | "getCollectionLimits"
> {
  return {
    listWatchlist: async () => ({ channels: [] }),
    createCollectionRequest: async () => {
      throw new Error("not used");
    },
    listCollectionRequests: async () => ({ requests: [] }),
    getCollectionLimits: async () => {
      throw new Error("not used");
    },
    getWatchlistEntryContext: async () => {
      throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry for the requested channel" });
    },
    listTopics: async () => ({ topics: [] }),
    listTrendCandidates: async () => ({ trendCandidates: [] }),
    listDiscoveryCandidates: async () => ({ candidates: [] }),
    createMarketResearchRequest: async () => {
      throw new Error("not used");
    },
  };
}

test("MCP query_competitors returns an empty roster for an empty watchlist", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    makeMarketIntelligenceCoreStub()
  );
  const result = await handlers.queryCompetitors({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.channels, []);
});

test("MCP query_competitors returns exactly one entry for a single-channel watchlist", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.listWatchlist = async () => ({
    channels: [{ channelId: "UC_1", handleOrUrl: null, reason: "competitor in the same niche", addedAt: "2026-09-26T00:00:00.000Z" , latestUploadPublishedAt: null, inactive: false, pausedAt: null, pausedReason: null }],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.queryCompetitors({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channels.length, 1);
  assert.equal(payload.channels[0].channelId, "UC_1");
});

test("MCP query_competitors returns the watchlist unchanged for 2+ entries (AC-CAP-05b's own listWatchlist passthrough)", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.listWatchlist = async () => ({
    channels: [
      { channelId: "UC_1", handleOrUrl: null, reason: "competitor in the same niche", addedAt: "2026-09-26T00:00:00.000Z" , latestUploadPublishedAt: null, inactive: false, pausedAt: null, pausedReason: null },
      { channelId: "UC_2", handleOrUrl: "@example", reason: "fast-growing format", addedAt: "2026-09-25T00:00:00.000Z" , latestUploadPublishedAt: null, inactive: false, pausedAt: null, pausedReason: null },
    ],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.queryCompetitors({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channels.length, 2);
  assert.deepEqual(
    payload.channels.map((c: { channelId: string }) => c.channelId),
    ["UC_1", "UC_2"]
  );
});

test("MCP query_competitors rejects an unexpected input field as validation_failed", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    makeMarketIntelligenceCoreStub()
  );
  const result = await handlers.queryCompetitors({ unexpectedField: "oops" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP query_market_intelligence requires channelId -- validation_failed before any store call", async () => {
  let getWatchlistEntryContextCalled = false;
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.getWatchlistEntryContext = async () => {
    getWatchlistEntryContextCalled = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.queryMarketIntelligence({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
  assert.equal(getWatchlistEntryContextCalled, false);
});

test("MCP query_market_intelligence surfaces RESEARCH_CHANNEL_NOT_AVAILABLE for a channel not on the watchlist", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    makeMarketIntelligenceCoreStub()
  );
  const result = await handlers.queryMarketIntelligence({ channelId: "UC_not_watched" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});

test("MCP query_market_intelligence returns the channel's own record with an empty evidence array when none has been recorded yet", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.getWatchlistEntryContext = async (input: unknown) => {
    const { channelId } = input as { channelId: string };
    return {
      channel: { channelId, handleOrUrl: null, reason: "worth watching", addedAt: "2026-09-26T00:00:00.000Z" , latestUploadPublishedAt: null, inactive: false, pausedAt: null, pausedReason: null },
      evidence: [],
      channelSnapshots: [],
      videoSnapshots: [],
      topicAssignments: [],
      dataQualityFlags: [],
      neverObserved: false,
      uniqueVideoCount: 0,
      latestVideoSnapshotAt: null,
      collectionProgress: STUB_COLLECTION_PROGRESS,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.queryMarketIntelligence({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channel.channelId, "UC_1");
  assert.deepEqual(payload.evidence, []);
});

test("MCP query_market_intelligence returns the channel's own record plus its full evidence history for 2+ evidence rows", async () => {
  let capturedInput: unknown;
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.getWatchlistEntryContext = async (input: unknown) => {
    capturedInput = input;
    return {
      channel: { channelId: "UC_1", handleOrUrl: null, reason: "worth watching", addedAt: "2026-09-26T00:00:00.000Z" , latestUploadPublishedAt: null, inactive: false, pausedAt: null, pausedReason: null },
      evidence: [
        {
          evidenceId: "ev1",
          researchChannelId: "UC_1",
          observation: "Public snapshot for \"Example\": ~1000 subscribers, 5000 total views, 10 videos",
          source: "youtube.channels.list",
          confidence: "high",
          collectedAt: "2026-09-25T00:00:00.000Z",
        },
        {
          evidenceId: "ev2",
          researchChannelId: "UC_1",
          observation: "manual observation: new upload format",
          source: "manual observation",
          confidence: null,
          collectedAt: "2026-09-26T00:00:00.000Z",
        },
      ],
      channelSnapshots: [],
      videoSnapshots: [],
      topicAssignments: [],
      dataQualityFlags: [],
      neverObserved: false,
      uniqueVideoCount: 0,
      latestVideoSnapshotAt: null,
      collectionProgress: STUB_COLLECTION_PROGRESS,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.queryMarketIntelligence({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channel.channelId, "UC_1");
  assert.equal(payload.evidence.length, 2);
  assert.deepEqual(
    payload.evidence.map((e: { evidenceId: string }) => e.evidenceId),
    ["ev1", "ev2"]
  );
  assert.deepEqual(capturedInput, { channelId: "UC_1" });
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part A -- agent_list_market_records (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md §6).
// ---------------------------------------------------------------------------

test("AC-9G-06: agent_list_market_records with kind:topics returns exactly listTopics()'s own result wrapped with kind", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.listTopics = async () => ({
    topics: [{ topicId: "topic-1", name: "Night Jazz Bar", addedAt: "2026-09-27T00:00:00.000Z" }],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.agentListMarketRecords({ kind: "topics" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.kind, "topics");
  assert.equal(payload.topics.length, 1);
  assert.equal(payload.topics[0].topicId, "topic-1");
});

test("AC-9G-06b: agent_list_market_records with kind:trend_candidates/discovery_candidates returns the matching list wrapped with kind", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.listTrendCandidates = async () => ({
    trendCandidates: [
      {
        trendCandidateId: "trend-1",
        title: "AI cover songs",
        description: null,
        topicId: null,
        status: "emerging",
        firstObservedAt: "2026-09-27T00:00:00.000Z",
        lastObservedAt: "2026-09-27T00:00:00.000Z",
      },
    ],
  });
  marketIntelligenceCore.listDiscoveryCandidates = async () => ({
    candidates: [
      {
        channelId: "UC_DISCOVERED000000000",
        title: "Discovered Channel",
        status: "new",
        discoverySource: "youtube.search.list",
        discoveryQuery: "night jazz",
        reasonDiscovered: null,
        firstSeenAt: "2026-09-27T00:00:00.000Z",
        lastSeenAt: "2026-09-27T00:00:00.000Z",
        stats: null,
        match: null,
      },
    ],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );

  const trendResult = await handlers.agentListMarketRecords({ kind: "trend_candidates" });
  const trendPayload = JSON.parse(trendResult.content[0]?.text ?? "{}");
  assert.equal(trendPayload.kind, "trend_candidates");
  assert.equal(trendPayload.trendCandidates[0].trendCandidateId, "trend-1");

  const discoveryResult = await handlers.agentListMarketRecords({ kind: "discovery_candidates" });
  const discoveryPayload = JSON.parse(discoveryResult.content[0]?.text ?? "{}");
  assert.equal(discoveryPayload.kind, "discovery_candidates");
  assert.equal(discoveryPayload.candidates[0].channelId, "UC_DISCOVERED000000000");
});

test("AC-9G-07: agent_list_market_records rejects an unknown kind value as validation_failed, before calling any service action", async () => {
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  let called = false;
  marketIntelligenceCore.listTopics = async () => {
    called = true;
    return { topics: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.agentListMarketRecords({ kind: "not_a_real_kind" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
  assert.equal(called, false);
});

test("AC-9G-08: agent_list_market_records is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      undefined,
      makeMarketIntelligenceCoreStub()
    );
    const result = await handlers.agentListMarketRecords({ kind: "topics" });
    assert.equal(result.isError, undefined);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part B -- agent_create_market_research_request
// (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §8). Zoning wiring itself is covered by the
// shared data-driven ZONED_MCP_TOOL_NAMES loop above.
// ---------------------------------------------------------------------------

test("MCP agent_create_market_research_request server-stamps createdVia:\"mcp\"/agentApiVersion and forwards the parsed input unchanged", async () => {
  let capturedInput: unknown;
  let capturedCallOrigin: unknown;
  const marketIntelligenceCore = makeMarketIntelligenceCoreStub();
  marketIntelligenceCore.createMarketResearchRequest = async (input, callOrigin) => {
    capturedInput = input;
    capturedCallOrigin = callOrigin;
    return {
      requestId: "req-1",
      query: (input as { query: string }).query,
      rationale: (input as { rationale: string }).rationale,
      monitorDurationDays: null,
      status: "pending",
      createdVia: "mcp",
      agentApiVersion: AGENT_API_VERSION,
      createdAt: "2026-09-27T00:00:00.000Z",
      resolvedAt: null,
      resolvedReason: null,
      candidatesFound: null,
      candidatesNew: null,
      executionError: null,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    marketIntelligenceCore
  );
  const result = await handlers.agentCreateMarketResearchRequest({ query: "night jazz bar", rationale: "worth watching" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.status, "pending");
  assert.deepEqual(capturedInput, { query: "night jazz bar", rationale: "worth watching" });
  assert.deepEqual(capturedCallOrigin, { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION });
});

test("AC-9G-B-11: agent_create_market_research_request is rejected while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      undefined,
      makeMarketIntelligenceCoreStub()
    );
    const result = await handlers.agentCreateMarketResearchRequest({ query: "night jazz", rationale: "worth watching" });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    assert.equal(payload.error.code, "operation_lock_held");
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md)
type DecisionEngineCoreStubShape = Pick<DecisionEngineCore, "listHypotheses" | "getHypothesisTrail" | "createExperiment">;

function makeDecisionEngineCoreStub(overrides: Partial<DecisionEngineCoreStubShape> = {}): DecisionEngineCoreStubShape {
  return {
    listHypotheses: async () => [],
    getHypothesisTrail: async () => {
      throw new DomainError({ code: "HYPOTHESIS_NOT_FOUND", message: "Hypothesis not found" });
    },
    createExperiment: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

const fakeHypothesis = {
  hypothesisId: "hyp-1",
  channelId: null,
  statement: "Shorter titles improve CTR",
  evidenceNotes: "Manual observation",
  createdBy: "user-1",
  createdVia: "web_ui",
  createdAt: "2026-09-29T00:00:00.000Z",
} as const;

const fakeExperiment = {
  experimentId: "exp-1",
  hypothesisId: "hyp-1",
  treatment: "10-char titles",
  controlBaseline: "current titles",
  successCriteria: "CTR +5%",
  stoppingCriteria: "14 days",
  startConditions: null,
  plannedDuration: null,
  sampleCoverageConstraints: null,
  budgetEstimate: null,
  responsible: "owner",
  status: "proposed" as const,
  approvedBy: null,
  approvedAt: null,
  changeSetId: null,
  executionBatchId: null,
  createdVia: "web_ui",
  createdAt: "2026-09-29T00:00:00.000Z",
};

test("MCP agent_list_hypotheses returns exactly the service layer's own already-channel-filtered list", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub({ listHypotheses: async () => [fakeHypothesis] })
  );
  const result = await handlers.agentListHypotheses({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.hypotheses, [fakeHypothesis]);
});

// The composition itself (hypothesis + experiments + outcomes, not-found-before-listing) is
// tested at the service level now (getHypothesisTrail, decision-engine/services.test.ts) -- these
// two just prove the MCP handler passes hypothesisId/ctx through and forwards the result/error
// unchanged, since the handler no longer composes anything itself (advisor-review fix: the
// composition used to be written out separately here and in the CLI handler).
test("MCP agent_get_hypothesis_trail surfaces HYPOTHESIS_NOT_FOUND for an unknown id, from the service layer unchanged", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub()
  );
  const result = await handlers.agentGetHypothesisTrail({ hypothesisId: "hyp-unknown" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "HYPOTHESIS_NOT_FOUND");
});

test("MCP agent_get_hypothesis_trail returns exactly what getHypothesisTrail resolves, passing hypothesisId/userId through", async () => {
  let capturedArgs: unknown;
  const fakeTrail = { hypothesis: fakeHypothesis, experiments: [{ ...fakeExperiment, outcomes: [] }], evidence: [] };
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub({
      getHypothesisTrail: async (hypothesisId, ctx) => {
        capturedArgs = { hypothesisId, ctx };
        return fakeTrail;
      },
    })
  );
  const result = await handlers.agentGetHypothesisTrail({ hypothesisId: "hyp-1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload, fakeTrail);
  assert.deepEqual(capturedArgs, { hypothesisId: "hyp-1", ctx: { userId: "active-user" } });
});

test("MCP create_experiment_proposal rejects a request missing a required field as validation_failed, before ever calling the core", async () => {
  let createExperimentCalled = false;
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub({
      createExperiment: async () => {
        createExperimentCalled = true;
        return fakeExperiment;
      },
    })
  );
  const result = await handlers.createExperimentProposal({ hypothesisId: "hyp-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
  assert.equal(createExperimentCalled, false);
});

test("MCP create_experiment_proposal forwards hypothesisId separately, stamps createdBy/createdVia, and never accepts a caller-supplied status", async () => {
  let capturedArgs: unknown;
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub({
      createExperiment: async (hypothesisId, input, ctx) => {
        capturedArgs = { hypothesisId, input, ctx };
        return fakeExperiment;
      },
    })
  );
  const result = await handlers.createExperimentProposal({
    hypothesisId: "hyp-1",
    treatment: "10-char titles",
    controlBaseline: "current titles",
    successCriteria: "CTR +5%",
    stoppingCriteria: "14 days",
    responsible: "owner",
    status: "approved",
  });

  assert.equal(result.isError, true);
  const rejected = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(rejected.error.code, "validation_failed");
  assert.equal(capturedArgs, undefined);

  const success = await handlers.createExperimentProposal({
    hypothesisId: "hyp-1",
    treatment: "10-char titles",
    controlBaseline: "current titles",
    successCriteria: "CTR +5%",
    stoppingCriteria: "14 days",
    responsible: "owner",
  });
  assert.equal(success.isError, undefined);
  assert.deepEqual(capturedArgs, {
    hypothesisId: "hyp-1",
    input: {
      treatment: "10-char titles",
      controlBaseline: "current titles",
      successCriteria: "CTR +5%",
      stoppingCriteria: "14 days",
      responsible: "owner",
    },
    ctx: { userId: "active-user", createdBy: "agent", createdVia: "mcp" },
  });
});

test("MCP create_experiment_proposal propagates a channel-context rejection from the service layer unchanged", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    makeDecisionEngineCoreStub({
      createExperiment: async () => {
        throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "Not authorized for this channel" });
      },
    })
  );
  const result = await handlers.createExperimentProposal({
    hypothesisId: "hyp-other-channel",
    treatment: "t",
    controlBaseline: "c",
    successCriteria: "s",
    stoppingCriteria: "st",
    responsible: "owner",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_AUTHORIZED");
});

// Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-07/08/10) -- agent_get_channel_workspace.
// Positional args up to the new trailing channelWorkspacesCore parameter.
function makeChannelWorkspaceHandlers(
  channelAccessCore: Parameters<typeof createMcpToolHandlers>[4],
  getWorkspace: (input: unknown) => Promise<{ configured: false } | { configured: true; path: string }>
) {
  return createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    channelAccessCore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { getWorkspace }
  );
}

test("MCP agent_get_channel_workspace returns the stored path for the active channel, and { configured: false } when unset", async () => {
  const stored: Record<string, string> = { UC_1: "/Users/op/channels/one" };
  const handlers = makeChannelWorkspaceHandlers(makeChannelAccessCoreStub(), async (input) => {
    const { channelId } = input as { channelId: string };
    return stored[channelId] ? { configured: true, path: stored[channelId] } : { configured: false };
  });

  const configured = await handlers.agentGetChannelWorkspace({ channelId: "UC_1" });
  assert.equal(configured.isError, undefined);
  assert.deepEqual(JSON.parse(configured.content[0]?.text ?? "{}"), { configured: true, path: "/Users/op/channels/one" });

  const unset = await handlers.agentGetChannelWorkspace({ channelId: "UC_2" });
  assert.deepEqual(JSON.parse(unset.content[0]?.text ?? "{}"), { configured: false });
});

test("MCP agent_get_channel_workspace rejects a non-active channel before the core is ever reached", async () => {
  const handlers = makeChannelWorkspaceHandlers(makeRestrictiveChannelAccessStub(), async () => {
    throw new Error("must not be called");
  });
  const result = await handlers.agentGetChannelWorkspace({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
  assert.equal(JSON.stringify(payload).includes("/"), false, "no path may leak in the error");
});

test("MCP agent_get_channel_workspace rejects an extra `path` field -- it can never act as a setter", async () => {
  const handlers = makeChannelWorkspaceHandlers(makeChannelAccessCoreStub(), async () => {
    throw new Error("must not be called");
  });
  const result = await handlers.agentGetChannelWorkspace({ channelId: "UC_1", path: "/tmp/evil" });

  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0]?.text ?? "{}").error.code, "validation_failed");
});

test("MCP server registers agent_get_channel_workspace and no tool that can set or clear a channel workspace", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};

  assert.ok(tools.agent_get_channel_workspace, "agent_get_channel_workspace must be registered");
  const workspaceTools = Object.keys(tools).filter((name) => name.includes("workspace"));
  assert.deepEqual(workspaceTools.sort(), ["agent_get_channel_workspace"]);
});

// Research export (ADR 0019, docs/roadmap/plans/RESEARCH_EXPORT_PLAN.md) -- agent_export_research_data.
function makeResearchExportHandlers(
  channelAccessCore: Parameters<typeof createMcpToolHandlers>[4],
  exportResearchData: (input: unknown) => Promise<unknown>
) {
  return createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    channelAccessCore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { exportResearchData } as never
  );
}

test("MCP agent_export_research_data passes the parsed input (defaults filled in) to the core and returns only its summary", async () => {
  let received: unknown;
  const summary = { generatedAt: "2026-10-04T07:15:30.000Z", exportsDir: "/ws/exports", files: [], watchlistChannels: { exported: 0, withoutSnapshots: [] }, retentionNote: "x" };
  const handlers = makeResearchExportHandlers(makeChannelAccessCoreStub(), async (input) => {
    received = input;
    return summary;
  });
  const result = await handlers.agentExportResearchData({ channelId: "UC_1" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(received, { channelId: "UC_1", includeOwnChannel: true, formats: ["csv"] });
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? "{}"), summary);
});

test("MCP agent_export_research_data rejects a non-active channel before the core is ever reached", async () => {
  const handlers = makeResearchExportHandlers(makeRestrictiveChannelAccessStub(), async () => {
    throw new Error("must not be called");
  });
  const result = await handlers.agentExportResearchData({ channelId: "UC_OTHER" });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0]?.text ?? "{}").error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_export_research_data rejects a caller-chosen path or file name (the Manager chooses both)", async () => {
  const handlers = makeResearchExportHandlers(makeChannelAccessCoreStub(), async () => {
    throw new Error("must not be called");
  });
  for (const extra of [{ path: "/tmp/evil" }, { fileName: "x.csv" }, { directory: "/" }]) {
    const result = await handlers.agentExportResearchData({ channelId: "UC_1", ...extra });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0]?.text ?? "{}").error.code, "validation_failed");
  }
});

// Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-01/02/08).
test("AC-P12-01: connection enabled but no agent session (no/invalid token) registers zero tools", () => {
  assert.deepEqual(registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true })), []);
  assert.deepEqual(registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: null })), []);
});

test("AC-P12-01: the master connection toggle off still registers zero tools even with a valid session", () => {
  assert.deepEqual(registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: false, agentSession: TEST_AGENT_SESSION })), []);
});

test("AC-P12-08: an agent session registers exactly the tools classified bound -- nothing unclassified, nothing operator-only", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION })).sort();
  const bound = Object.entries(MCP_TOOL_CLASSIFICATION)
    .filter(([, toolClass]) => toolClass === "bound")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(names, bound);
});

test("AC-P12-08: the classification table covers every tool the server source registers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const registered = [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.ok(registered.length > 40, "sanity: expected to find the registered tool names in server.ts");
  assert.deepEqual(registered, Object.keys(MCP_TOOL_CLASSIFICATION).sort());
});

test("AC-P12-02: a revoked token fails the very next call of a running session, before any handler runs", async () => {
  let revoked = false;
  const server = createMcpServer(makeCoreStub(), {
    connectionEnabled: true,
    agentSession: {
      tokenId: "test-token",
      channelId: "UC_1",
      async reverify() {
        if (revoked) throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "revoked" });
      },
    },
  });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })
    ._registeredTools;

  await runInAgentSession({ tokenId: "test-token", channelId: "UC_1", userId: "u" }, async () => {
    const before = await tools.agent_get_capabilities.handler({});
    assert.notEqual(before.isError, true);
    revoked = true;
    const after = await tools.agent_get_capabilities.handler({});
    assert.equal(after.isError, true);
    assert.equal(JSON.parse(after.content[0].text).error.code, "AGENT_TOKEN_INVALID");
  });
});

// docs/decisions/0013-in-app-http-mcp-transport.md, AC-HM-08: in the web process "no scope" means
// operator mode, so a handler must never run unless the ambient scope is exactly this request's token.
test("AC-HM-08: a tool call with no ambient scope, or another token's scope, is refused before any handler runs", async () => {
  let handlerRan = false;
  const core = makeCoreStub();
  const original = core.listVideos;
  core.listVideos = (async (...args: Parameters<typeof original>) => {
    handlerRan = true;
    return original(...args);
  }) as typeof original;
  const server = createMcpServer(core, { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })
    ._registeredTools;

  const noScope = await tools.list.handler({ channelId: "UC_1" });
  assert.equal(noScope.isError, true);
  await runInAgentSession({ tokenId: "another-token", channelId: "UC_1", userId: "u" }, async () => {
    const wrongScope = await tools.list.handler({ channelId: "UC_1" });
    assert.equal(wrongScope.isError, true);
  });
  assert.equal(handlerRan, false);
});

// ---------------------------------------------------------------------------
// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md): agent_create_collection_request (DRAFT, gated),
// agent_get_collection_request / agent_get_collection_limits (READ). Expected behavior is derived from the plan section 2/7 rules.
// ---------------------------------------------------------------------------

function makeCollectionHandlers(options: {
  assigned: Record<string, string[]>;
  watchlist?: string[];
  createResult?: unknown;
  requests?: Array<{ requestId: string }>;
  limits?: unknown;
}) {
  const created: Array<{ input: unknown; callOrigin: unknown }> = [];
  const owned: Array<[string, string]> = [];
  const marketAssignmentCore = {
    async filterForAgent<T>(kind: string, items: T[], idOf: (item: T) => string) {
      return items.filter((item) => (options.assigned[kind] ?? []).includes(idOf(item)));
    },
    async assertAvailableToAgent(kind: string, id: string) {
      if (!(options.assigned[kind] ?? []).includes(id)) throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "no" });
    },
    async recordAgentOwnership(kind: string, id: string) {
      owned.push([kind, id]);
    },
  };
  const marketIntelligenceCore = {
    ...makeMarketIntelligenceCoreStub(),
    listWatchlist: async () => ({ channels: (options.watchlist ?? []).map((channelId) => ({ channelId })) }),
    createCollectionRequest: async (input: unknown, callOrigin: unknown) => {
      created.push({ input, callOrigin });
      return options.createResult ?? { created: true, request: { requestId: "cr-1" }, notNeeded: [], alreadyRequested: [] };
    },
    listCollectionRequests: async () => ({ requests: options.requests ?? [] }),
    getCollectionLimits: async () => options.limits ?? { dailyBudgetUnits: 1000 },
  } as never;
  const handlers = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, makeChannelAccessCoreStub(),
    undefined, undefined, undefined, marketIntelligenceCore, undefined, undefined, marketAssignmentCore as never
  );
  return { handlers, created, owned };
}
const parseToolJson = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

test("MCP agent_create_collection_request: server-stamps mcp + AGENT_API_VERSION, forwards the explicit ids and reason, records ownership of the new request", async () => {
  const { handlers, created, owned } = makeCollectionHandlers({ assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa"] } });
  const result = await handlers.agentCreateCollectionRequest({ researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa"], reason: "weekly check" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(created, [
    {
      input: { researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa"], reason: "weekly check" },
      callOrigin: { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION },
    },
  ]);
  assert.deepEqual(owned, [["collection_request", "cr-1"]]);
  assert.equal(parseToolJson(result).created, true);
});

test("MCP agent_create_collection_request: a channel not assigned to the agent is refused like a nonexistent one, before anything is created", async () => {
  const { handlers, created, owned } = makeCollectionHandlers({ assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa"] } });
  const result = await handlers.agentCreateCollectionRequest({ researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa", "UCbbbbbbbbbbbbbbbbbbbbbb"] });
  assert.equal(result.isError, true);
  assert.equal(parseToolJson(result).error.code, "RESEARCH_CHANNEL_NOT_AVAILABLE");
  assert.deepEqual(created, []);
  assert.deepEqual(owned, []);
});

test("MCP agent_create_collection_request: with no ids the default is the watchlist narrowed to the agent's assignments; an empty narrowed list is created:false without calling the core", async () => {
  const withOne = makeCollectionHandlers({
    assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa"] },
    watchlist: ["UCaaaaaaaaaaaaaaaaaaaaaa", "UCbbbbbbbbbbbbbbbbbbbbbb"],
  });
  await withOne.handlers.agentCreateCollectionRequest({});
  assert.deepEqual((withOne.created[0].input as { researchChannelIds: string[] }).researchChannelIds, ["UCaaaaaaaaaaaaaaaaaaaaaa"]);

  const none = makeCollectionHandlers({ assigned: { research_channel: [] }, watchlist: ["UCbbbbbbbbbbbbbbbbbbbbbb"] });
  const result = await none.handlers.agentCreateCollectionRequest({});
  assert.deepEqual(parseToolJson(result), { created: false, request: null, notNeeded: [], alreadyRequested: [] });
  assert.deepEqual(none.created, []);
});

test("MCP agent_create_collection_request: no ownership is recorded when nothing was created (created:false)", async () => {
  const { handlers, owned } = makeCollectionHandlers({
    assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa"] },
    createResult: { created: false, request: null, notNeeded: [{ channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", reason: "collected_recently", hoursSince: 2 }], alreadyRequested: [] },
  });
  const result = await handlers.agentCreateCollectionRequest({ researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa"] });
  assert.equal(parseToolJson(result).created, false);
  assert.deepEqual(owned, []);
});

test("MCP agent_create_collection_request: strict input -- a force flag, a >500-character reason, an empty id list and a malformed id are validation_failed", async () => {
  const { handlers, created } = makeCollectionHandlers({ assigned: { research_channel: [] } });
  for (const bad of [{ force: true }, { reason: "x".repeat(501) }, { researchChannelIds: [] }, { researchChannelIds: ["not-an-id"] }]) {
    const result = await handlers.agentCreateCollectionRequest(bad);
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.equal(parseToolJson(result).error.code, "validation_failed");
  }
  assert.deepEqual(created, []);
});

test("MCP agent_create_collection_request is rejected while the operation lock is held; the two reads are not gated", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const { handlers, created } = makeCollectionHandlers({ assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa"] } });
    const blocked = await handlers.agentCreateCollectionRequest({ researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa"] });
    assert.equal(blocked.isError, true);
    assert.equal(parseToolJson(blocked).error.code, "operation_lock_held");
    assert.deepEqual(created, []);
    assert.equal((await handlers.agentGetCollectionLimits({})).isError, undefined);
    assert.equal((await handlers.agentGetCollectionRequest({})).isError, undefined);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_get_collection_request: shows only requests assigned to the agent; an unassigned id is COLLECTION_REQUEST_NOT_FOUND, same as an unknown one", async () => {
  const { handlers } = makeCollectionHandlers({
    assigned: { collection_request: ["cr-mine"] },
    requests: [{ requestId: "cr-other" }, { requestId: "cr-mine" }],
  });
  assert.deepEqual(parseToolJson(await handlers.agentGetCollectionRequest({ requestId: "cr-mine" })).request, { requestId: "cr-mine" });
  for (const id of ["cr-other", "cr-missing"]) {
    const result = await handlers.agentGetCollectionRequest({ requestId: id });
    assert.equal(result.isError, true);
    assert.equal(parseToolJson(result).error.code, "COLLECTION_REQUEST_NOT_FOUND");
  }
  assert.deepEqual(parseToolJson(await handlers.agentGetCollectionRequest({})).requests, [{ requestId: "cr-mine" }]);
  assert.equal((await handlers.agentGetCollectionRequest({ requestId: "x", extra: 1 })).isError, true);
});

test("MCP agent_get_collection_limits returns the core's limits unchanged and accepts only an empty input", async () => {
  const limits = { dailyBudgetUnits: 1000, unitsSpentToday: 120, remainingTodayUnits: 880 };
  const { handlers } = makeCollectionHandlers({ assigned: {}, limits });
  assert.deepEqual(parseToolJson(await handlers.agentGetCollectionLimits({})), limits);
  assert.equal((await handlers.agentGetCollectionLimits({ foo: 1 })).isError, true);
});

test("MCP server: the three collection-request tools are registered for a bound agent session, and nothing that approves, runs or rejects one is", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION }));
  for (const tool of ["agent_create_collection_request", "agent_get_collection_request", "agent_get_collection_limits"]) {
    assert.ok(names.includes(tool), tool);
  }
  assert.ok(!names.some((n) => /approve|reject|run_.*collection|collection.*(run|approve|reject)/.test(n)), "no approve/run/reject collection tool may exist");
});

test("MCP agent_create_collection_request: alreadyRequested discloses a requestId only when that request is assigned to the agent", async () => {
  const { handlers } = makeCollectionHandlers({
    assigned: { research_channel: ["UCaaaaaaaaaaaaaaaaaaaaaa", "UCbbbbbbbbbbbbbbbbbbbbbb"], collection_request: ["cr-mine"] },
    createResult: {
      created: false,
      request: null,
      notNeeded: [],
      alreadyRequested: [
        { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", requestId: "cr-mine" },
        { channelId: "UCbbbbbbbbbbbbbbbbbbbbbb", requestId: "cr-someone-else" },
      ],
    },
  });
  const result = await handlers.agentCreateCollectionRequest({ researchChannelIds: ["UCaaaaaaaaaaaaaaaaaaaaaa", "UCbbbbbbbbbbbbbbbbbbbbbb"] });
  assert.deepEqual(parseToolJson(result).alreadyRequested, [
    { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", requestId: "cr-mine" },
    { channelId: "UCbbbbbbbbbbbbbbbbbbbbbb" },
  ]);
});

// ---------------------------------------------------------------------------
// Phase 14 slice 5 (docs/roadmap/plans/PHASE_14_PLAN.md §2.7, AC-P14-16): the seven media_generation tools. Expected behaviour comes
// from the plan: channel-bound, request/read/job only, approve/start/stop never registered, create/request/cancel gated.
// ---------------------------------------------------------------------------

function makeMediaHandlers(options: { channelOfSession?: string; channelOfJob?: string } = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const session = { sessionId: "ms-1", channelId: options.channelOfSession ?? "UC_1", status: "running", podId: "pod1" };
  const job = { jobId: "mj-1", sessionId: "ms-1", channelId: options.channelOfJob ?? "UC_1", status: "submitted" };
  const mediaCore = {
    requestSession: async (input: unknown) => {
      calls.push({ method: "requestSession", input });
      return { ...session, status: "pending", requestedBy: (input as { requestedBy: string }).requestedBy };
    },
    getSession: async () => session,
    // Review round 6: the channel filter is pushed into the store query (never a post-filter of a capped page), so the
    // fake honours the argument the way `listMediaSessions(limit, channelId)` does.
    listSessions: async (limit: number, channelId?: string) => {
      calls.push({ method: "listSessions", input: { limit, channelId } });
      return [session, { ...session, sessionId: "ms-other", channelId: "UC_other" }].filter((s) => !channelId || s.channelId === channelId);
    },
    getLimits: async () => ({ maxUsdPerDay: 10, spentTodayUsd: 1, remainingTodayUsd: 9, defaultMaxMinutes: 60, idleMinutes: 10, watchIntervalSeconds: 60, openSessions: [{ ...session, channelId: "UC_other" }, { ...session, sessionId: "ms-mine", channelId: "UC_1" }], openSession: { ...session, channelId: "UC_other" }, maxConcurrentSessions: 3, activeSessionCount: 2, ready: true, missing: [] }),
    listWorkflowTemplates: async () => [{ templateId: "t1", name: "txt2img" }],
    createJob: async (input: unknown) => {
      calls.push({ method: "createJob", input });
      return job;
    },
    getJob: async () => job,
    listJobs: async (input: unknown) => {
      calls.push({ method: "listJobs", input });
      return [job];
    },
    cancelJob: async (input: unknown) => {
      calls.push({ method: "cancelJob", input });
      return { ...job, status: "cancelled" };
    },
    releaseSession: async (input: unknown) => {
      calls.push({ method: "releaseSession", input });
      return { ...session, status: "done", stopReason: "released by the channel agent" };
    },
  };
  const handlers = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, makeChannelAccessCoreStub(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mediaCore as never
  );
  return { handlers, calls };
}

// BL-135 (ADR 0023 amendment 2, owner 2026-10-06) amended AC-P14-16: the channel may now END its own session
// (agent_release_media_session) -- still no tool can approve, start, resume or reject one.
test("MCP server registers the eight media tools; the only session-ending one is the release, and none can approve, start or reject", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  const media = Object.keys(tools).filter((name) => name.includes("media")).sort();
  assert.deepEqual(media, [
    "agent_cancel_media_job",
    "agent_create_media_job",
    "agent_get_media_job",
    "agent_get_media_limits",
    "agent_get_media_session",
    "agent_list_media_templates",
    "agent_release_media_session",
    "agent_request_media_session",
  ]);
  assert.ok(!Object.keys(tools).some((name) => /media.*(approve|start|stop|reject|resume)/.test(name)));
  for (const name of media) assert.equal(MCP_TOOL_CLASSIFICATION[name], "bound");
});

test("MCP agent_request_media_session stamps requestedBy:agent and forwards the caps; a non-active channel is refused before the core", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const ok = await handlers.agentRequestMediaSession({ channelId: "UC_1", maxMinutes: 30, maxUsd: 2, reason: "thumbnails" });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls, [{ method: "requestSession", input: { channelId: "UC_1", maxMinutes: 30, maxUsd: 2, reason: "thumbnails", requestedBy: "agent" } }]);
  assert.equal(parseToolJson(ok).session.requestedBy, "agent");

  const strict = makeMediaHandlers();
  const rejectingAccess = {
    ...makeChannelAccessCoreStub(),
    assertActiveChannel: async () => {
      throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not active" });
    },
  };
  const handlers2 = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, rejectingAccess,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    {
      requestSession: async () => {
        throw new Error("must not be reached");
      },
    } as never
  );
  const refused = await handlers2.agentRequestMediaSession({ channelId: "UC_2" });
  assert.equal(refused.isError, true);
  assert.equal(parseToolJson(refused).error.code, "CHANNEL_NOT_AUTHORIZED");
  assert.deepEqual(strict.calls, []);
  // Strict input: a requestedBy field cannot be supplied by the caller.
  const extra = await handlers.agentRequestMediaSession({ channelId: "UC_1", requestedBy: "operator" });
  assert.equal(parseToolJson(extra).error.code, "validation_failed");
});

test("MCP agent_get_media_session / agent_get_media_job: another channel's session or job is reported as not found; lists are narrowed to the channel", async () => {
  const other = makeMediaHandlers({ channelOfSession: "UC_other", channelOfJob: "UC_other" });
  assert.equal(parseToolJson(await other.handlers.agentGetMediaSession({ channelId: "UC_1", sessionId: "ms-1" })).error.code, "media_session_not_found");
  assert.equal(parseToolJson(await other.handlers.agentGetMediaJob({ channelId: "UC_1", jobId: "mj-1" })).error.code, "media_job_not_found");
  assert.equal(parseToolJson(await other.handlers.agentCancelMediaJob({ channelId: "UC_1", jobId: "mj-1" })).error.code, "media_job_not_found");
  assert.ok(!other.calls.some((c) => c.method === "cancelJob"));

  const mine = makeMediaHandlers();
  const sessions = parseToolJson(await mine.handlers.agentGetMediaSession({ channelId: "UC_1" })).sessions;
  assert.deepEqual(sessions.map((s: { sessionId: string }) => s.sessionId), ["ms-1"]);
  assert.deepEqual(mine.calls.at(-1), { method: "listSessions", input: { limit: 20, channelId: "UC_1" } });
  await mine.handlers.agentGetMediaJob({ channelId: "UC_1", sessionId: "ms-1" });
  assert.deepEqual(mine.calls.at(-1), { method: "listJobs", input: { channelId: "UC_1", sessionId: "ms-1" } });
});

// Agent API 3.4.0 (slice 6, PHASE_14_PLAN.md §5.2): several sessions may be open; only the caller's channel's are disclosed.
test("MCP agent_get_media_limits discloses only this channel's open sessions; other channels count only in the device-wide numbers", async () => {
  const { handlers } = makeMediaHandlers();
  const limits = parseToolJson(await handlers.agentGetMediaLimits({ channelId: "UC_1" }));
  assert.deepEqual((limits.openSessions as Array<{ sessionId: string }>).map((s) => s.sessionId), ["ms-mine"]);
  assert.equal((limits.openSession as { sessionId: string }).sessionId, "ms-mine");
  assert.ok(!JSON.stringify(limits).includes("UC_other"), "another channel's session is never disclosed");
  assert.equal(limits.deviceHasOpenSession, true);
  assert.equal(limits.maxConcurrentSessions, 3);
  assert.equal(limits.activeSessionCount, 2);
  assert.equal(limits.remainingTodayUsd, 9);
});

test("MCP agent_create_media_job stamps createdBy:agent; request/create/cancel are rejected while the operation lock is held, the reads are not", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const ok = await handlers.agentCreateMediaJob({ channelId: "UC_1", sessionId: "ms-1", templateId: "t1", params: { prompt: "a cat" } });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls, [{ method: "createJob", input: { channelId: "UC_1", sessionId: "ms-1", templateId: "t1", params: { prompt: "a cat" }, createdBy: "agent" } }]);

  await acquireOperationLock(rawSqlClient, "export");
  try {
    const locked = makeMediaHandlers();
    for (const blocked of [
      await locked.handlers.agentRequestMediaSession({ channelId: "UC_1" }),
      await locked.handlers.agentCreateMediaJob({ channelId: "UC_1", sessionId: "ms-1", templateId: "t1" }),
      await locked.handlers.agentCancelMediaJob({ channelId: "UC_1", jobId: "mj-1" }),
    ]) {
      assert.equal(blocked.isError, true);
      assert.equal(parseToolJson(blocked).error.code, "operation_lock_held");
    }
    assert.deepEqual(locked.calls, []);
    assert.equal((await locked.handlers.agentListMediaTemplates({ channelId: "UC_1" })).isError, undefined);
    assert.equal((await locked.handlers.agentGetMediaLimits({ channelId: "UC_1" })).isError, undefined);
    assert.equal((await locked.handlers.agentGetMediaJob({ channelId: "UC_1" })).isError, undefined);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// BL-157 (review round 3; ADR 0029 §4, ADR 0031): only the factory links a job to a generation plan (checked by the plans module,
// under the plan's lock). A channel agent's job naming a plan is refused before anything is created.
// BL-157 (review round 6): the same for a session -- only the factory links a session to a plan (checked by the plans module).
test("MCP agent_request_media_session refuses a `planId` link (only the factory links a session to a plan)", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const refused = await handlers.agentRequestMediaSession({ channelId: "UC_1", planId: "R-0001-S1-music" });
  assert.equal(refused.isError, true);
  assert.equal(parseToolJson(refused).error.code, "validation_failed");
  assert.deepEqual(calls, []);
});

// BL-159 (review): a session's own minimum host CUDA is set only through the factory's start -- never by a channel agent.
test("MCP agent_request_media_session refuses a `minCudaVersion` (only the factory sets a session's own minimum)", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const refused = await handlers.agentRequestMediaSession({ channelId: "UC_1", minCudaVersion: "13.0" });
  assert.equal(refused.isError, true);
  assert.equal(parseToolJson(refused).error.code, "validation_failed");
  assert.deepEqual(calls, []);
});

test("MCP agent_create_media_job refuses a `plan` link (only the factory links a job to a plan)", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const refused = await handlers.agentCreateMediaJob({ channelId: "UC_1", sessionId: "ms-1", templateId: "t1", plan: { planId: "R-0001-S1-music", stageId: "generate", itemKey: "C1/F1" } });
  assert.equal(refused.isError, true);
  assert.equal(parseToolJson(refused).error.code, "validation_failed");
  assert.deepEqual(calls, []);
});

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F4, AC-FO-05/09/13) -- agent_list_logical_paths and
// agent_get_logical_path. Positional args up to the trailing logicalPathsCore parameter (index 16 since the Phase 14 merge put mediaGenerationCore at 15).
function makeLogicalPathHandlers(logicalPathsCore: Parameters<typeof createMcpToolHandlers>[16]) {
  // Indexes 3..15 keep their real defaults (undefined); only the trailing parameter is injected.
  const create = createMcpToolHandlers as (...args: unknown[]) => ReturnType<typeof createMcpToolHandlers>;
  return create(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), ...Array.from({ length: 13 }, () => undefined), logicalPathsCore);
}

test("MCP agent_get_logical_path / agent_list_logical_paths always ask the registry for the CHANNEL scope, whatever the input", async () => {
  const scopes: string[] = [];
  const handlers = makeLogicalPathHandlers({
    async readPath(input, scope) {
      scopes.push(scope);
      return { name: (input as { name: string }).name, path: "/Factory/02 Shared Registry" };
    },
    async listReadable(scope) {
      scopes.push(scope);
      return [{ name: "factory_shared", description: "", configured: true, path: "/Factory/02 Shared Registry" }];
    },
  });

  const one = await handlers.agentGetLogicalPath({ name: "factory_shared" });
  assert.equal(one.isError, undefined);
  assert.deepEqual(JSON.parse(one.content[0]?.text ?? "{}"), { name: "factory_shared", path: "/Factory/02 Shared Registry" });

  const list = await handlers.agentListLogicalPaths({});
  assert.deepEqual(JSON.parse(list.content[0]?.text ?? "{}").paths.map((p: { name: string }) => p.name), ["factory_shared"]);
  assert.deepEqual(scopes, ["channel", "channel"]);

  // A caller cannot widen the scope through input: an extra field is rejected before the registry is reached.
  for (const result of [
    await handlers.agentGetLogicalPath({ name: "developer_exchange", scope: "factory" }),
    await handlers.agentGetLogicalPath({ name: "factory_shared", path: "/etc" }),
    await handlers.agentListLogicalPaths({ scope: "factory" }),
  ]) {
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0]?.text ?? "{}").error.code, "validation_failed");
  }
  assert.deepEqual(scopes, ["channel", "channel"], "a rejected input never reaches the registry");
});

test("MCP agent_get_logical_path maps registry errors to stable codes and leaks no path in them", async () => {
  const { DomainError } = await import("@/lib/shared-domain");
  for (const code of ["LOGICAL_PATH_NOT_FOUND", "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE"] as const) {
    const handlers = makeLogicalPathHandlers({
      async readPath() {
        throw new DomainError({ code, message: "m", details: { name: "x" } });
      },
      async listReadable() {
        return [];
      },
    });
    const result = await handlers.agentGetLogicalPath({ name: "some_name" });
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    assert.equal(payload.error.code, code);
    assert.equal(JSON.stringify(payload).includes("\\"), false);
  }
});

test("MCP server registers exactly the two read-only logical path tools for a channel session, and no tool that can set one", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true, agentSession: TEST_AGENT_SESSION });
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  assert.ok(tools.agent_list_logical_paths);
  assert.ok(tools.agent_get_logical_path);
  assert.deepEqual(Object.keys(tools).filter((name) => name.includes("logical_path")).sort(), ["agent_get_logical_path", "agent_list_logical_paths"]);
  assert.equal(Object.keys(tools).some((name) => name.startsWith("factory_")), false);
});

test("agent_get_capabilities lists the two logical path capabilities as READ, tied to their MCP tools", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
  const payload = JSON.parse((await handlers.agentGetCapabilities({})).content[0]?.text ?? "{}");
  const byId = new Map((payload.capabilities as Array<{ id: string; permission: string; mcpTools?: string[] }>).map((c) => [c.id, c]));
  assert.equal(byId.get("logical_paths.list_logical_paths")?.permission, "READ");
  assert.deepEqual(byId.get("logical_paths.list_logical_paths")?.mcpTools, ["agent_list_logical_paths"]);
  assert.equal(byId.get("logical_paths.get_logical_path")?.permission, "READ");
  assert.deepEqual(byId.get("logical_paths.get_logical_path")?.mcpTools, ["agent_get_logical_path"]);
  assert.ok(payload.dataDomains.includes("logical_path_values"));
});

test("BL-135 MCP agent_release_media_session passes the caller's channel to the core (which only releases that channel's session); a non-active channel is refused before the core", async () => {
  const { handlers, calls } = makeMediaHandlers();
  const ok = await handlers.agentReleaseMediaSession({ channelId: "UC_1", sessionId: "ms-1" });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls, [{ method: "releaseSession", input: { sessionId: "ms-1", channelId: "UC_1" } }]);
  assert.equal(parseToolJson(ok).session.status, "done");
  const rejectingAccess = {
    ...makeChannelAccessCoreStub(),
    assertActiveChannel: async () => {
      throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not active" });
    },
  };
  const guarded = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, rejectingAccess,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    {
      releaseSession: async () => {
        throw new Error("must not be reached");
      },
    } as never
  );
  const refused = await guarded.agentReleaseMediaSession({ channelId: "UC_2", sessionId: "ms-1" });
  assert.equal(refused.isError, true);
  assert.equal(parseToolJson(refused).error.code, "CHANNEL_NOT_AUTHORIZED");
  const extra = await handlers.agentReleaseMediaSession({ channelId: "UC_1", sessionId: "ms-1", force: true });
  assert.equal(extra.isError, true, "strict input");
});

// BL-143 phase 3 (GENERATION_PLANS_PHASE_3_PLAN.md AC-GP3-03): read-only plan tools, the session's active channel only, never
// item params or job error texts.
function makePlanHandlers(access = makeChannelAccessCoreStub()) {
  const view = (channelId: string, planId: string) => ({
    plan: {
      planId,
      title: "Waves",
      channelId,
      owner: "factory",
      status: "active",
      budget: { usd: 2, gpuMinutes: null },
      note: null,
      revision: 1,
      createdAt: "2026-10-07T09:00:00.000Z",
      updatedAt: "2026-10-07T09:00:00.000Z",
      closedAt: null,
      stages: [{ stageId: "generate", title: "Generate", kind: "in_app" }],
      groups: [],
      items: [{ itemKey: "C1/F1", groupId: null, templateLabel: null, templateId: "tpl", variant: null, targetCount: 2, mode: "fixed", maxAttempts: null, params: { prompt: "secret prompt" }, seeds: [1] }],
    },
    progress: { notices: [] },
  });
  const plans = { listPlans: async () => [view("UC_1", "mine"), view("UC_other", "theirs")], getPlan: async ({ planId }: { planId: string }) => ({ ...view(planId === "theirs" ? "UC_other" : "UC_1", planId), events: [{ at: "2026-10-07T09:05:00.000Z", kind: "job_failed", actor: "app", details: { jobId: "j1", error: "EACCES '/Volumes/SSD/ws'" } }], cursor: "" }) };
  return createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, access,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, plans as never
  );
}

test("AC-GP3-03: agent_list/get_generation_plan(s) show only this channel's plans, without item params or job error text", async () => {
  const handlers = makePlanHandlers();
  const listed = parseToolJson(await handlers.agentListGenerationPlans({ channelId: "UC_1" }));
  assert.deepEqual(listed.plans.map((p: { planId: string }) => p.planId), ["mine"]);
  assert.ok(!JSON.stringify(listed).includes("secret prompt"), "no job params");
  const one = parseToolJson(await handlers.agentGetGenerationPlan({ channelId: "UC_1", planId: "mine" }));
  assert.equal(one.plan.planId, "mine");
  assert.deepEqual(one.events[0].details, { jobId: "j1" }, "no error text");
  assert.equal(parseToolJson(await handlers.agentGetGenerationPlan({ channelId: "UC_1", planId: "theirs" })).error.code, "plan_not_found");
  const refused = makePlanHandlers({ ...makeChannelAccessCoreStub(), assertActiveChannel: async () => { throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not active" }); } });
  assert.equal(parseToolJson(await refused.agentListGenerationPlans({ channelId: "UC_2" })).error.code, "CHANNEL_NOT_AUTHORIZED");
  assert.equal(MCP_TOOL_CLASSIFICATION.agent_list_generation_plans, "bound");
  assert.equal(MCP_TOOL_CLASSIFICATION.agent_get_generation_plan, "bound");
});

test("re-review: the agent's plan view drops error texts at any depth and passes since/latest through", async () => {
  const seen: unknown[] = [];
  const view = {
    plan: { planId: "mine", title: "T", channelId: "UC_1", owner: "factory", status: "active", budget: { usd: null, gpuMinutes: null }, note: null, revision: 1, createdAt: "", updatedAt: "", closedAt: null, stages: [], groups: [], items: [] },
    progress: { notices: [], spend: { usd: 0.1, gpuMinutes: 1, sessions: [{ sessionId: "s", status: "failed", usd: 0.1, final: true, stopReason: "start failed: RunPod said /Volumes/x" }] } },
    events: [
      { at: "2026-10-07T09:05:00.000Z", kind: "stage_run", actor: "factory", details: { created: 1, stoppedAt: { itemKey: "C1/F1", seed: 2, error: { code: "media_input_unavailable", message: "/Volumes/SSD/ws/missing.png" } } } },
      { at: "2026-10-07T09:06:00.000Z", kind: "session_stopped", actor: "app", details: { sessionId: "s", stopReason: "start failed: boom" } },
      // BL-157 (ADR 0004/0031): a move names the other channel -- not this agent's to see.
      { at: "2026-10-07T09:07:00.000Z", kind: "plan_moved", actor: "factory", details: { from: "UC_other_channel", to: "UC_1", checked: 34 } },
    ],
    more: true,
    cursor: "2026-10-07T09:06:00.000Z",
  };
  const plans = { listPlans: async () => [view], getPlan: async (input: unknown) => (seen.push(input), view) };
  const handlers = createMcpToolHandlers(
    makeCoreStub(), makeAuthStub(), makeOperationsCoreStub(), undefined, makeChannelAccessCoreStub(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, plans as never
  );
  const out = parseToolJson(await handlers.agentGetGenerationPlan({ channelId: "UC_1", planId: "mine" }));
  const text = JSON.stringify(out);
  assert.ok(!text.includes("/Volumes") && !text.includes("boom") && !text.includes("RunPod said"), text);
  assert.ok(!text.includes("UC_other_channel"), "the move's other channel is not shown to the agent");
  assert.deepEqual(out.events[2], { at: "2026-10-07T09:07:00.000Z", kind: "plan_moved", actor: "factory", details: { checked: 34 } });
  assert.deepEqual(out.events[0].details.stoppedAt, { itemKey: "C1/F1", seed: 2 });
  assert.equal(out.more, true);
  assert.equal(out.cursor, "2026-10-07T09:06:00.000Z");
  await handlers.agentGetGenerationPlan({ channelId: "UC_1", planId: "mine", since: "2026-10-07T09:00:00.000Z" });
  assert.deepEqual(seen, [{ planId: "mine", latest: true }, { planId: "mine", since: "2026-10-07T09:00:00.000Z" }]);
  const listed = JSON.stringify(parseToolJson(await handlers.agentListGenerationPlans({ channelId: "UC_1" })));
  assert.ok(!listed.includes("RunPod said"), "spend sessions carry no stop reason");
});
