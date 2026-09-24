import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createAgentOperationsServices } from "./services";

type FakeChannel = { channelId: string; title: string; lastSyncedAt: Date | null };
type FakeVideo = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
  lastSyncedAt: Date;
};
type FakeProfile = {
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

type FakeChannelOverview = {
  channelId: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  daily: Array<{ date: string; views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }>;
  currentTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
  previousTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
};
type FakeListMetricsResult = {
  channelId: string;
  rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
};

function createFixture(
  overrides: Partial<{
    productVersion: string;
    schemaVersion: number;
    channels: Record<string, FakeChannel>;
    videosByChannel: Record<string, FakeVideo[]>;
    profilesByChannel: Record<string, FakeProfile | null>;
    trackedLanguagesByChannel: Record<string, string[]>;
    getChannelOverview: (input: unknown) => Promise<FakeChannelOverview>;
    listMetrics: (input: unknown) => Promise<FakeListMetricsResult>;
    now: () => Date;
  }> = {}
) {
  const services = createAgentOperationsServices({
    getProductVersion: () => overrides.productVersion ?? "9.9.9",
    getSchemaVersion: () => overrides.schemaVersion ?? 14,
    channelStore: {
      async getChannel(channelId: string) {
        return overrides.channels?.[channelId] ?? null;
      },
      async listVideosByChannel(channelId: string) {
        return overrides.videosByChannel?.[channelId] ?? [];
      },
    },
    async getEditorialProfile(channelId: string) {
      return overrides.profilesByChannel?.[channelId] ?? null;
    },
    async getTrackedLanguages(channelId: string) {
      return overrides.trackedLanguagesByChannel?.[channelId] ?? [];
    },
    getChannelOverview: overrides.getChannelOverview ?? (async () => { throw new Error("getChannelOverview not stubbed"); }),
    listMetrics: overrides.listMetrics ?? (async () => { throw new Error("listMetrics not stubbed"); }),
    now: overrides.now ?? (() => new Date("2026-09-24T12:00:00.000Z")),
  });
  return { services };
}

// AC-CAP-01: every field the owner spec §4 asked `get_system_capabilities()` to report is
// actually present, using injected (not real) dependencies so this test doesn't depend on the
// real package.json version or the real current schema version.
test("getSystemCapabilities returns every field the spec requires, sourced from injected dependencies", async () => {
  const { services } = createFixture({ productVersion: "9.9.9", schemaVersion: 14 });
  const result = await services.getSystemCapabilities({});

  assert.equal(result.productVersion, "9.9.9");
  assert.equal(result.agentApiVersion, "0.3.0");
  assert.equal(result.schemaVersions.app, 14);
  assert.ok(Array.isArray(result.capabilities));
  assert.ok(Array.isArray(result.dataDomains));
  assert.ok(Array.isArray(result.actionClasses));
  assert.ok(Array.isArray(result.grantedPermissions));
  assert.ok(Array.isArray(result.plannedFutureCapabilities));
});

// AC-CAP-02: the single most safety-critical assertion in this slice -- Codex (or any agent)
// must never be told it holds APPROVE/EXECUTE, since granting either implicitly would violate
// the owner's own explicit "AI may propose, human approves" invariant (AGENTS.md §G).
test("grantedPermissions is exactly READ+DRAFT -- never APPROVE or EXECUTE", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(result.grantedPermissions, ["READ", "DRAFT"]);
  assert.ok(!result.grantedPermissions.includes("APPROVE" as never));
  assert.ok(!result.grantedPermissions.includes("EXECUTE" as never));
});

// AC-CAP-03: actionClasses is the full 4-class vocabulary the permission MODEL recognizes,
// deliberately a superset of what's actually granted -- an agent must be able to tell "this
// system has an APPROVE concept, I just don't hold it" from "this system has no such concept."
test("actionClasses lists all four permission classes, distinct from the narrower grantedPermissions", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(result.actionClasses, ["READ", "DRAFT", "APPROVE", "EXECUTE"]);
  assert.ok(result.actionClasses.length > result.grantedPermissions.length);
});

// AC-CAP-04: this capability must describe itself -- an agent calling get_capabilities should
// see the very tool it just called listed as an available READ capability.
test("capabilities includes system.get_capabilities itself, classified READ", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  const self = result.capabilities.find((c) => c.id === "system.get_capabilities");
  assert.ok(self, "system.get_capabilities must list itself");
  assert.equal(self!.permission, "READ");
  assert.equal(self!.domain, "system");
});

// AC-CAP-05: exactly the three future capabilities the owner's own spec §14 named as extension
// points -- not more (scope creep into implying an unbuilt capability exists) and not fewer.
test("plannedFutureCapabilities is exactly the three extension points from the owner's spec §14, no more no less", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(
    [...result.plannedFutureCapabilities].sort(),
    ["create_experiment_proposal", "query_competitors", "query_market_intelligence"].sort()
  );
});

// AC-CAP-08: the input schema is a strict empty object -- an unexpected extra field must fail
// loudly (validation_failed), never be silently ignored.
test("rejects an unexpected input field as validation_failed", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getSystemCapabilities({ unexpectedField: "oops" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("accepts a genuinely empty input object", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});
  assert.ok(result.agentApiVersion);
});

// AC-CTX-01/03/04: every field getChannelContext returns is sourced from the injected
// dependencies, with an unsynced channel and a never-saved profile correctly reported as
// null/absent -- never fabricated.
test("getChannelContext returns channel basics, video count, editorial profile, and tracked languages", async () => {
  const { services } = createFixture({
    channels: { UC_A: { channelId: "UC_A", title: "Rural Japan Music", lastSyncedAt: new Date("2026-09-20T12:00:00Z") } },
    videosByChannel: { UC_A: [fakeVideo({ videoId: "v1" }), fakeVideo({ videoId: "v2" })] },
    profilesByChannel: {
      UC_A: {
        version: 3,
        targetAudience: "Ambient music listeners",
        toneNotes: null,
        terminologyNotes: null,
        titleConstraints: null,
        descriptionConstraints: null,
        updatedAt: "2026-09-19T00:00:00.000Z",
      },
    },
    trackedLanguagesByChannel: { UC_A: ["es", "fr"] },
  });

  const result = await services.getChannelContext({ channelId: "UC_A" });

  assert.equal(result.channelId, "UC_A");
  assert.equal(result.title, "Rural Japan Music");
  assert.equal(result.lastSyncedAt, "2026-09-20T12:00:00.000Z");
  assert.equal(result.syncedVideoCount, 2);
  assert.equal(result.editorialProfile!.version, 3);
  assert.equal(result.editorialProfile!.targetAudience, "Ambient music listeners");
  assert.deepEqual(result.trackedLanguages, ["es", "fr"]);
});

test("getChannelContext reports lastSyncedAt as null (never fabricated) for a channel never synced, and editorialProfile as null when none was ever saved", async () => {
  const { services } = createFixture({
    channels: { UC_A: { channelId: "UC_A", title: "New Channel", lastSyncedAt: null } },
    videosByChannel: {},
    profilesByChannel: {},
    trackedLanguagesByChannel: {},
  });

  const result = await services.getChannelContext({ channelId: "UC_A" });

  assert.equal(result.lastSyncedAt, null);
  assert.equal(result.editorialProfile, null);
  assert.equal(result.syncedVideoCount, 0);
  assert.deepEqual(result.trackedLanguages, []);
});

// AC-CTX-02: a channel that has never been locally synced must fail loudly, never return an
// empty-but-successful context that looks like a real, empty channel.
test("getChannelContext throws DATA_NOT_SYNCED for a channel with no local record", async () => {
  const { services } = createFixture({ channels: {} });

  await assert.rejects(
    () => services.getChannelContext({ channelId: "UC_UNKNOWN" }),
    (error: unknown) => error instanceof DomainError && error.code === "DATA_NOT_SYNCED"
  );
});

function fakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  return {
    videoId: "v1",
    channelId: "UC_A",
    title: "Original Title",
    description: "Original description",
    publishedAt: "2026-09-01T00:00:00Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    existingLocalizations: { es: { title: "Titulo", description: "Descripcion" } },
    lastSyncedAt: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

// AC-CTX-05/08: default (no `include`) returns BOTH sections, and localizations is correctly
// derived from the stored existingLocalizations map, one entry per language.
test("getVideoContext returns both metadata and localizations by default", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: [fakeVideo()] } });

  const result = await services.getVideoContext({ channelId: "UC_A", videoId: "v1" });

  assert.deepEqual(result.includedSections.sort(), ["localizations", "metadata"]);
  assert.equal(result.metadata!.title, "Original Title");
  assert.equal(result.metadata!.publishedAt, "2026-09-01T00:00:00Z");
  assert.deepEqual(result.localizations, [{ language: "es", title: "Titulo", description: "Descripcion" }]);
});

// AC-CTX-06: narrowing `include` to one section must OMIT the other field entirely (undefined),
// not return it empty -- a caller checking `"localizations" in result` must see it's genuinely
// absent, per owner spec §23's token-efficiency requirement.
test("getVideoContext narrows to exactly the requested sections when `include` is given", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: [fakeVideo()] } });

  const result = await services.getVideoContext({ channelId: "UC_A", videoId: "v1", include: ["metadata"] });

  assert.deepEqual(result.includedSections, ["metadata"]);
  assert.ok(result.metadata);
  assert.equal(result.localizations, undefined);
});

// AC-CTX-07: a videoId that doesn't belong to the requested channel (wrong channel, typo, or
// genuinely never synced) must fail loudly, never silently return a cross-channel video's data.
test("getVideoContext throws DATA_NOT_SYNCED for a videoId not found in the requested channel", async () => {
  const { services } = createFixture({ videosByChannel: { UC_A: [fakeVideo({ videoId: "v1" })] } });

  await assert.rejects(
    () => services.getVideoContext({ channelId: "UC_A", videoId: "v-does-not-exist" }),
    (error: unknown) => error instanceof DomainError && error.code === "DATA_NOT_SYNCED"
  );
});

test("agent capabilities list includes the two new slice-B capabilities with correct domain/permission", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  const channelCap = result.capabilities.find((c) => c.id === "channel_context.get_channel_context");
  const videoCap = result.capabilities.find((c) => c.id === "video_context.get_video_context");
  assert.ok(channelCap);
  assert.equal(channelCap!.domain, "channel_context");
  assert.equal(channelCap!.permission, "READ");
  assert.ok(videoCap);
  assert.equal(videoCap!.domain, "video_context");
});

// AC-CAP-09 (slice C, owner spec §28): get_capabilities must now also report the pre-existing
// tools it previously omitted (found by independent advisor review, 2026-09-24), plus the two new
// query_*_analytics wrappers -- one representative check per registered id/domain/permission
// combination named in the owner's own §25 initial capability set.
test("agent capabilities list registers pre-existing tools (list_channels/list_videos/localization draft) and the two new analytics wrappers", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});
  const ids = result.capabilities.map((c) => c.id);

  assert.ok(ids.includes("channel_context.list_channels"));
  assert.ok(ids.includes("video_context.list_videos"));
  assert.ok(ids.includes("localization_draft.create_localization_proposals"));
  assert.ok(ids.includes("localization_draft.create_change_set_from_agent_proposals"));
  assert.ok(ids.includes("analytics.query_channel_analytics"));
  assert.ok(ids.includes("analytics.query_video_analytics"));

  const draftCap = result.capabilities.find((c) => c.id === "localization_draft.create_change_set_from_agent_proposals");
  assert.equal(draftCap!.permission, "DRAFT");
});

// AC-ANALYTICS-01/02/03 (slice C, owner spec §9): "Create agent-oriented analytics queries...
// Every result must include metric definitions, period, dimensional filters... data freshness."
test("queryChannelAnalytics forwards input unchanged to getChannelOverview and wraps the result with metric definitions + live-API freshness", async () => {
  let captured: unknown;
  const { services } = createFixture({
    now: () => new Date("2026-09-24T15:00:00.000Z"),
    getChannelOverview: async (input) => {
      captured = input;
      return {
        channelId: "UC_A",
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        previousStartDate: "2026-08-25",
        previousEndDate: "2026-08-31",
        daily: [{ date: "2026-09-01", views: 10, estimatedMinutesWatched: 5, subscribersGained: 1, subscribersLost: 0 }],
        currentTotals: { views: 10, estimatedMinutesWatched: 5, subscribersGained: 1, subscribersLost: 0 },
        previousTotals: { views: 8, estimatedMinutesWatched: 4, subscribersGained: 0, subscribersLost: 1 },
      };
    },
  });

  const result = await services.queryChannelAnalytics({
    credentialRef: { userId: "u1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
  });

  assert.deepEqual(captured, {
    credentialRef: { userId: "u1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
  });
  assert.deepEqual(result.period, {
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    previousStartDate: "2026-08-25",
    previousEndDate: "2026-08-31",
  });
  // Independently known (from src/lib/analytics/contracts.ts's own CHANNEL_OVERVIEW_METRIC_NAMES,
  // not derived from this module's own output): exactly these 4 metric names, each with a
  // definition present.
  assert.deepEqual(
    result.metricDefinitions.map((d) => d.name).sort(),
    ["estimatedMinutesWatched", "subscribersGained", "subscribersLost", "views"].sort()
  );
  assert.ok(result.metricDefinitions.every((d) => d.description.length > 0));
  assert.equal(result.freshness.source, "live_youtube_analytics_api");
  assert.equal(result.freshness.asOf, "2026-09-24T15:00:00.000Z");
  assert.deepEqual(result.currentTotals, { views: 10, estimatedMinutesWatched: 5, subscribersGained: 1, subscribersLost: 0 });
  assert.deepEqual(result.daily, [{ date: "2026-09-01", views: 10, estimatedMinutesWatched: 5, subscribersGained: 1, subscribersLost: 0 }]);
});

test("queryChannelAnalytics rejects a missing credentialRef as validation_failed (required, not optional -- see schema's own doc comment)", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.queryChannelAnalytics({ channelId: "UC_A", startDate: "2026-09-01", endDate: "2026-09-07" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// Symmetry with the queryChannelAnalytics test above (found by independent review, 2026-09-24) --
// this exact same required-credentialRef property carries equal safety weight for both functions.
test("queryVideoAnalytics rejects a missing credentialRef as validation_failed (required, not optional -- see schema's own doc comment)", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.queryVideoAnalytics({ channelId: "UC_A" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("queryVideoAnalytics forwards input unchanged to listMetrics and wraps the result with local-read freshness, defaulting metric definitions to the full known list when metricNames is omitted", async () => {
  let captured: unknown;
  const { services } = createFixture({
    now: () => new Date("2026-09-24T15:00:00.000Z"),
    listMetrics: async (input) => {
      captured = input;
      return {
        channelId: "UC_A",
        rows: [{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 42 }],
      };
    },
  });

  const result = await services.queryVideoAnalytics({ credentialRef: { userId: "u1" }, channelId: "UC_A" });

  assert.deepEqual(captured, { credentialRef: { userId: "u1" }, channelId: "UC_A" });
  assert.deepEqual(result.period, { startDate: null, endDate: null });
  assert.deepEqual(result.filters, { videoId: null, metricNames: null });
  // Independently known: src/lib/analytics/contracts.ts's own ANALYTICS_METRIC_NAMES currently
  // has exactly 28 entries -- omitting `metricNames` must describe all of them, not a subset.
  assert.equal(result.metricDefinitions.length, 28);
  assert.equal(result.freshness.source, "local_collected_data");
  assert.deepEqual(result.rows, [{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 42 }]);
});

test("queryVideoAnalytics narrows metricDefinitions to exactly the requested metricNames, and never fabricates a definition for an unrecognized name", async () => {
  const { services } = createFixture({
    listMetrics: async () => ({ channelId: "UC_A", rows: [] }),
  });

  const result = await services.queryVideoAnalytics({
    credentialRef: { userId: "u1" },
    channelId: "UC_A",
    metricNames: ["views", "totally_made_up_metric"],
  });

  assert.deepEqual(result.metricDefinitions.map((d) => d.name), ["views", "totally_made_up_metric"]);
  const viewsDefinition = result.metricDefinitions.find((d) => d.name === "views");
  assert.equal(viewsDefinition!.unit, "count");
  const unknownDefinition = result.metricDefinitions.find((d) => d.name === "totally_made_up_metric");
  assert.equal(unknownDefinition!.description, "No definition recorded for this metric name.");
});
