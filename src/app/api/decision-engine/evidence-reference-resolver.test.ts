// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §9 (AGENTS.md §L
// -- written from the requirement, not copied from a draft implementation's own output). Found
// necessary by advisor review: the service-layer tests (services.test.ts) only prove
// addHypothesisEvidence does whatever a FAKE resolver says -- nothing there exercises the REAL
// resolver's own existence-checking logic. This file is what actually proves §9's own criteria
// ("a real row -> accepted", "a nonexistent date/metric/snapshot id -> rejected").
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createRealEvidenceReferenceResolver } from "./evidence-reference-resolver";

function createFakeAnalyticsCore(rows: { videoId: string; metricDate: string; metricName: string; metricValue: number }[]) {
  return {
    async listMetrics(input: { channelId: string; videoId?: string; metricNames?: string[] }) {
      return {
        channelId: input.channelId,
        rows: rows.filter(
          (row) => (!input.videoId || row.videoId === input.videoId) && (!input.metricNames || input.metricNames.includes(row.metricName))
        ),
      };
    },
  };
}

function createFailingAnalyticsCore(error: unknown) {
  return {
    async listMetrics(): Promise<never> {
      throw error;
    },
  };
}

function createFakeMarketIntelligenceCore(args: {
  channelSnapshotIds?: string[];
  videoSnapshotIds?: string[];
  trendCandidateIds?: string[];
  throwOnSnapshots?: unknown;
}) {
  return {
    async listChannelSnapshots() {
      if (args.throwOnSnapshots) throw args.throwOnSnapshots;
      return { snapshots: (args.channelSnapshotIds ?? []).map((snapshotId) => ({ snapshotId }) as never) };
    },
    async listVideoSnapshots() {
      if (args.throwOnSnapshots) throw args.throwOnSnapshots;
      return { snapshots: (args.videoSnapshotIds ?? []).map((snapshotId) => ({ snapshotId }) as never) };
    },
    async listTrendCandidates() {
      return { trendCandidates: (args.trendCandidateIds ?? []).map((trendCandidateId) => ({ trendCandidateId }) as never) };
    },
  };
}

test("AC-10-16: phase8_metric resolves true for a real (videoId, metricDate, metricName) row", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 }]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({}),
  });

  const resolved = await resolver.resolve(
    { sourceType: "phase8_metric", channelId: "UC1", videoId: "v1", metricDate: "2026-09-01", metricName: "views" },
    { userId: "u1" }
  );

  assert.equal(resolved, true);
});

test("AC-10-17: phase8_metric resolves false when the same video exists but the metricDate differs", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 }]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({}),
  });

  const resolved = await resolver.resolve(
    { sourceType: "phase8_metric", channelId: "UC1", videoId: "v1", metricDate: "2026-09-02", metricName: "views" },
    { userId: "u1" }
  );

  assert.equal(resolved, false);
});

test("AC-10-17b: phase8_metric resolves false when the same video/date exists but the metricName differs", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 }]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({}),
  });

  const resolved = await resolver.resolve(
    { sourceType: "phase8_metric", channelId: "UC1", videoId: "v1", metricDate: "2026-09-01", metricName: "likes" },
    { userId: "u1" }
  );

  assert.equal(resolved, false);
});

test("AC-10-18: a real channel-access failure from listMetrics (CHANNEL_NOT_ACTIVE) propagates, never swallowed into false", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFailingAnalyticsCore(new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" })),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({}),
  });

  await assert.rejects(
    () => resolver.resolve({ sourceType: "phase8_metric", channelId: "UCother", videoId: "v1", metricDate: "2026-09-01", metricName: "views" }, { userId: "u1" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("AC-10-19: phase9_channel_snapshot/phase9_video_snapshot resolve true for a present id, false for an absent one", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({ channelSnapshotIds: ["snap-1"], videoSnapshotIds: ["snap-2"] }),
  });

  assert.equal(
    await resolver.resolve({ sourceType: "phase9_channel_snapshot", researchChannelId: "UCr1", snapshotId: "snap-1" }, { userId: "u1" }),
    true
  );
  assert.equal(
    await resolver.resolve({ sourceType: "phase9_channel_snapshot", researchChannelId: "UCr1", snapshotId: "fabricated" }, { userId: "u1" }),
    false
  );
  assert.equal(
    await resolver.resolve({ sourceType: "phase9_video_snapshot", researchChannelId: "UCr1", snapshotId: "snap-2" }, { userId: "u1" }),
    true
  );
  assert.equal(
    await resolver.resolve({ sourceType: "phase9_video_snapshot", researchChannelId: "UCr1", snapshotId: "fabricated" }, { userId: "u1" }),
    false
  );
});

test("AC-10-20: phase9_trend_candidate resolves true for a present id, false for an absent one", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({ trendCandidateIds: ["trend-1"] }),
  });

  assert.equal(await resolver.resolve({ sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" }, { userId: "u1" }), true);
  assert.equal(await resolver.resolve({ sourceType: "phase9_trend_candidate", trendCandidateId: "fabricated" }, { userId: "u1" }), false);
});

test("AC-10-21: a researchChannelId not on the watchlist (RESEARCH_CHANNEL_NOT_AVAILABLE) resolves false, not a leaked market-intelligence error", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({
      throwOnSnapshots: new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry for the requested channel" }),
    }),
  });

  const resolved = await resolver.resolve(
    { sourceType: "phase9_channel_snapshot", researchChannelId: "UCnotwatched", snapshotId: "snap-1" },
    { userId: "u1" }
  );

  assert.equal(resolved, false);
});

test("AC-10-22: an unrelated error from market-intelligence still propagates, never silently swallowed", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([]),
    marketIntelligenceCore: createFakeMarketIntelligenceCore({ throwOnSnapshots: new Error("real infrastructure failure") }),
  });

  await assert.rejects(
    () => resolver.resolve({ sourceType: "phase9_channel_snapshot", researchChannelId: "UCr1", snapshotId: "snap-1" }, { userId: "u1" }),
    /real infrastructure failure/
  );
});

test("AC-10-23: resolve() returns false immediately when ctx.userId is missing, never calling either core", async () => {
  let called = false;
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: {
      async listMetrics() {
        called = true;
        return { channelId: "UC1", rows: [] };
      },
    },
    marketIntelligenceCore: createFakeMarketIntelligenceCore({}),
  });

  const resolved = await resolver.resolve(
    { sourceType: "phase8_metric", channelId: "UC1", videoId: "v1", metricDate: "2026-09-01", metricName: "views" },
    { userId: null }
  );

  assert.equal(resolved, false);
  assert.equal(called, false);
});

// Phase 13 (review round 5/6): III.E.4.h -- another channel's YouTube API values are never handed to
// the AI as evidence text; only that an observation exists, and when.
test("P13: describe() for competitor snapshots carries no counts and no video title", async () => {
  const resolver = createRealEvidenceReferenceResolver({
    analyticsCore: createFakeAnalyticsCore([]),
    marketIntelligenceCore: {
      async listChannelSnapshots() {
        return { snapshots: [{ snapshotId: "c1", observedAt: "2026-09-30T00:00:00.000Z", subscriberCount: 123457, viewCount: 9876543, videoCount: 321 }] as never };
      },
      async listVideoSnapshots() {
        return { snapshots: [{ snapshotId: "v1", videoId: "vidAAA", title: "Secret Competitor Title", observedAt: "2026-09-30T00:00:00.000Z", viewCount: 55555, likeCount: 4444 }] as never };
      },
      async listTrendCandidates() {
        return { trendCandidates: [] };
      },
    },
  } as never);
  const channel = await resolver.describe({ sourceType: "phase9_channel_snapshot", researchChannelId: "UCr1", snapshotId: "c1" } as never, { userId: "u1" });
  const video = await resolver.describe({ sourceType: "phase9_video_snapshot", researchChannelId: "UCr1", snapshotId: "v1" } as never, { userId: "u1" });
  for (const leaked of ["123457", "9876543", "321", "55555", "4444", "Secret Competitor Title"]) {
    assert.ok(!channel.includes(leaked) && !video.includes(leaked), `leaked ${leaked}`);
  }
  assert.match(channel, /2026-09-30/);
  assert.match(video, /2026-09-30/);
});
