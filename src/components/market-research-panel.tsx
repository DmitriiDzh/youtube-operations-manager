"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

type ResearchChannel = {
  channelId: string;
  handleOrUrl: string | null;
  reason: string;
  addedAt: string;
};

type ResearchEvidence = {
  evidenceId: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  collectedAt: string;
};

// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md) -- Channels
// intelligence view. Mirrors getChannelIntelligenceSummaryOutputSchema.
type FieldVelocity = { value: number | null; basis: "insufficient_history" | "stale_latest" | "partial_window" | "full_window" };
type BreakoutAssessment = {
  videoId: string;
  dayOffset: number;
  videoViewCount: number | null;
  channelBaselineMedianViewCount: number | null;
  ratio: number | null;
  isBreakout: boolean;
  reason: string;
};
type EmergingChannelAssessment = {
  recentBreakoutVideoCount: number;
  subscriberVelocityPerDay: number | null;
  isEmerging: boolean;
  reasons: string[];
};
type LatestVideoSnapshot = {
  videoId: string;
  observedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: string | null;
};
type ChannelIntelligenceSummary = {
  channelSnapshots: {
    observedAt: string;
    subscriberCount: number | null;
    viewCount: number | null;
    videoCount: number | null;
    hiddenSubscriberCount: boolean;
  }[];
  dataQualityFlags: string[];
  subscriberVelocity: FieldVelocity;
  uploadCadence: FieldVelocity;
  recentBreakoutVideos: BreakoutAssessment[];
  emergingChannel: EmergingChannelAssessment;
  latestSnapshotPerVideo: LatestVideoSnapshot[];
  methodology: {
    channelVelocityWindowDays: number;
    recentVideoWindowDays: number;
    channelBaselineDayOffset: number;
    breakoutMinBaselineSampleSize: number;
    breakoutBaselineToleranceDays: number;
  };
};

// A `stale_latest`/`partial_window` rate must never be presented as a genuine N-day window figure
// (derived-metrics.ts's own contract: `stale_latest` is a best-effort rate over a MUCH longer,
// unstated span, and `partial_window` only covers whatever span was actually observed) -- found by
// independent code review: an earlier version of this label always printed "(N-day window)"
// regardless of basis, contradicting the function it was displaying.
function formatFieldVelocity(field: FieldVelocity, unit: string, windowDays: number): string {
  if (field.value === null) return `no data (${field.basis})`;
  const perDay = field.value >= 0 ? `+${field.value.toFixed(2)}` : field.value.toFixed(2);
  const rate = `${perDay} ${unit}/day`;
  switch (field.basis) {
    case "full_window":
      return `${rate} over the last ${windowDays} days`;
    case "partial_window":
      return `${rate} (partial -- covers only the span actually observed, less than ${windowDays} days)`;
    case "stale_latest":
      return `${rate} (NOT a real last-${windowDays}-day rate -- the latest observation is itself older than ${windowDays} days; best-effort over a longer span)`;
    default:
      return `${rate} (${field.basis})`;
  }
}

// Phase 9 slices 2-3 (docs/roadmap/plans/PHASE_9_PLAN.md) -- global (not channel-scoped) market
// research watchlist. Manually-seeded: adding a channel and recording evidence are both
// operator-entered; "Fetch public snapshot" (slice 3) is the one action that makes a real
// outbound YouTube API call. No automatic discovery/prioritization exists (a later, unassigned
// slice, plan §6).
export function MarketResearchPanel() {
  const [channels, setChannels] = useState<ResearchChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [newChannelId, setNewChannelId] = useState("");
  const [newHandleOrUrl, setNewHandleOrUrl] = useState("");
  const [newReason, setNewReason] = useState("");
  const [adding, setAdding] = useState(false);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const [intelligence, setIntelligence] = useState<ChannelIntelligenceSummary | null>(null);
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [intelligenceError, setIntelligenceError] = useState<string | null>(null);
  // Tracks which channel the most recently STARTED fetch was for, so a slower, now-stale response
  // never overwrites a newer one that already landed (found by independent code review -- the
  // identical race already fixed in market-trends-panel.tsx/market-topics-panel.tsx, tracked as
  // RISK-77 for not yet sharing one hook across all three).
  const intelligenceRequestChannelIdRef = useRef<string | null>(null);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [videoHistory, setVideoHistory] = useState<{ observedAt: string; viewCount: number | null; likeCount: number | null; commentCount: number | null }[]>([]);
  const [videoHistoryLoading, setVideoHistoryLoading] = useState(false);
  const [videoHistoryError, setVideoHistoryError] = useState<string | null>(null);
  const videoHistoryRequestIdRef = useRef<string | null>(null);

  const [newObservation, setNewObservation] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newConfidence, setNewConfidence] = useState("");
  const [recordingEvidence, setRecordingEvidence] = useState(false);
  const [fetchingSnapshot, setFetchingSnapshot] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ResearchChannel | null>(null);
  const [removing, setRemoving] = useState(false);
  // Phase 9 slice 9B -- surfaces the Settings-tab quota slider's own "off" state here too
  // (plan §8: "an explicit 'auto-collection is off' state on the Research tab"), so an operator
  // who never visits Settings still learns why their watchlist's counts never refresh on their
  // own. `null` while unknown (still loading, or the fetch failed) never renders a banner either
  // way -- this is informational only, never a blocking error.
  const [autoCollectionBudgetUnits, setAutoCollectionBudgetUnits] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { marketIntelligenceDailyQuotaBudgetUnits?: number | null } | null) => {
        if (!cancelled) setAutoCollectionBudgetUnits(data?.marketIntelligenceDailyQuotaBudgetUnits ?? null);
      })
      .catch(() => {
        if (!cancelled) setAutoCollectionBudgetUnits(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/market-intelligence/channels");
      if (res.ok) {
        const data = await res.json();
        setChannels(data.channels ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  const fetchEvidence = useCallback(async (channelId: string) => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/evidence`);
      const data = await res.json();
      if (!res.ok) {
        setEvidenceError(data.message ?? "Failed to load evidence");
        return;
      }
      setEvidence(data.evidence ?? []);
    } finally {
      setEvidenceLoading(false);
    }
  }, []);

  const fetchIntelligenceSummary = useCallback(async (channelId: string) => {
    intelligenceRequestChannelIdRef.current = channelId;
    setIntelligenceLoading(true);
    setIntelligence(null);
    setIntelligenceError(null);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/intelligence-summary`);
      if (intelligenceRequestChannelIdRef.current !== channelId) return;
      if (res.ok) {
        setIntelligence(await res.json());
      } else {
        const data = await res.json().catch(() => ({}));
        setIntelligenceError(data.message ?? "Failed to load channel intelligence");
      }
    } finally {
      if (intelligenceRequestChannelIdRef.current === channelId) setIntelligenceLoading(false);
    }
  }, []);

  function handleSelectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    setExpandedVideoId(null);
    setVideoHistory([]);
    setVideoHistoryError(null);
    void fetchEvidence(channelId);
    void fetchIntelligenceSummary(channelId);
  }

  async function handleToggleVideoHistory(channelId: string, videoId: string) {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setVideoHistory([]);
      setVideoHistoryError(null);
      return;
    }
    videoHistoryRequestIdRef.current = videoId;
    setExpandedVideoId(videoId);
    setVideoHistoryLoading(true);
    setVideoHistory([]);
    setVideoHistoryError(null);
    try {
      const res = await fetch(
        `/api/market-intelligence/channels/${encodeURIComponent(channelId)}/videos/${encodeURIComponent(videoId)}/snapshot-history`
      );
      if (videoHistoryRequestIdRef.current !== videoId) return;
      if (res.ok) {
        const data = await res.json();
        setVideoHistory(data.snapshots ?? []);
      } else {
        const data = await res.json().catch(() => ({}));
        setVideoHistoryError(data.message ?? "Failed to load video history");
      }
    } finally {
      if (videoHistoryRequestIdRef.current === videoId) setVideoHistoryLoading(false);
    }
  }

  async function handleAddToWatchlist() {
    setError(null);
    if (!newChannelId || !newReason) {
      setError("Channel id and reason are required");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/market-intelligence/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: newChannelId,
          ...(newHandleOrUrl ? { handleOrUrl: newHandleOrUrl } : {}),
          reason: newReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to add channel to the watchlist");
        return;
      }
      setNewChannelId("");
      setNewHandleOrUrl("");
      setNewReason("");
      await fetchChannels();
    } finally {
      setAdding(false);
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(removeTarget.channelId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "Failed to remove channel from the watchlist");
        return;
      }
      if (selectedChannelId === removeTarget.channelId) {
        setSelectedChannelId(null);
        setEvidence([]);
        setIntelligence(null);
        setIntelligenceError(null);
        setExpandedVideoId(null);
        setVideoHistory([]);
        setVideoHistoryError(null);
      }
      await fetchChannels();
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  }

  async function handleFetchPublicSnapshot() {
    if (!selectedChannelId) return;
    setEvidenceError(null);
    setFetchingSnapshot(true);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(selectedChannelId)}/fetch-public-snapshot`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setEvidenceError(data.message ?? "Failed to fetch a public snapshot");
        return;
      }
      await fetchEvidence(selectedChannelId);
    } finally {
      setFetchingSnapshot(false);
    }
  }

  async function handleRecordEvidence() {
    if (!selectedChannelId) return;
    setEvidenceError(null);
    if (!newObservation || !newSource) {
      setEvidenceError("Observation and source are required");
      return;
    }
    setRecordingEvidence(true);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(selectedChannelId)}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observation: newObservation,
          source: newSource,
          ...(newConfidence ? { confidence: newConfidence } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEvidenceError(data.message ?? "Failed to record evidence");
        return;
      }
      setNewObservation("");
      setNewSource("");
      setNewConfidence("");
      await fetchEvidence(selectedChannelId);
    } finally {
      setRecordingEvidence(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Market research watchlist
          <InfoTooltip>
            A manually-seeded list of channels you want to track for competitive/market context --
            never automatically discovered, and never a source of private analytics for a channel
            you don&rsquo;t own. Each entry can carry public observations (evidence) you record
            yourself, each with its source.
          </InfoTooltip>
        </h3>
      </div>

      {!autoCollectionBudgetUnits && autoCollectionBudgetUnits !== undefined && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
          Auto-refresh is off &mdash; snapshots below are only added when you fetch them manually,
          and channel discovery below is also unavailable. Set a daily quota under Settings → API
          to enable both.
        </p>
      )}

      <div className="rounded-lg border border-zinc-800 p-4">
        <h4 className="mb-3 text-sm font-semibold text-zinc-200">Add a channel to the watchlist</h4>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-zinc-400">YouTube channel id (e.g. UC...)</span>
            <input
              value={newChannelId}
              onChange={(e) => setNewChannelId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Handle/URL (optional, informational only)</span>
            <input
              value={newHandleOrUrl}
              onChange={(e) => setNewHandleOrUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="col-span-2 block">
            <span className="text-xs text-zinc-400">Reason for tracking this channel</span>
            <input
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <button
          onClick={handleAddToWatchlist}
          disabled={adding}
          className="mt-3 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {adding ? "Adding..." : "Add to watchlist"}
        </button>
      </div>

      <div className="space-y-2">
        {loading && <p className="text-sm text-zinc-500">Loading...</p>}
        {!loading && channels.length === 0 && <p className="text-sm text-zinc-500">No channels on the watchlist yet.</p>}
        {channels.map((c) => (
          <div key={c.channelId} className="rounded-lg border border-zinc-800 p-3">
            <div className="flex items-start justify-between gap-2">
              <button
                onClick={() => handleSelectChannel(c.channelId)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="text-sm font-medium text-zinc-200">
                  {c.handleOrUrl ?? c.channelId} <span className="text-xs text-zinc-500">({c.channelId})</span>
                </p>
                <p className="text-xs text-zinc-400">{c.reason}</p>
                <p className="text-xs text-zinc-500">Added {formatDisplayDateTime(c.addedAt)}</p>
              </button>
              <button
                onClick={() => setRemoveTarget(c)}
                className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-red-400 hover:bg-zinc-800"
              >
                Remove
              </button>
            </div>

            {selectedChannelId === c.channelId && (
              <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3">
                {evidenceLoading && <p className="text-sm text-zinc-500">Loading evidence...</p>}
                {!evidenceLoading && evidence.length === 0 && (
                  <p className="text-sm text-zinc-500">No evidence recorded yet for this channel.</p>
                )}
                {!evidenceLoading &&
                  evidence.map((e) => (
                    <div key={e.evidenceId} className="rounded-md border border-zinc-800 p-2">
                      <p className="text-sm text-zinc-200">{e.observation}</p>
                      <p className="text-xs text-zinc-500">
                        Source: {e.source}
                        {e.confidence ? ` · Confidence: ${e.confidence}` : ""} · {formatDisplayDateTime(e.collectedAt)}
                      </p>
                    </div>
                  ))}

                <div className="rounded-lg border border-zinc-800 p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                    Intelligence
                    <InfoTooltip>
                      Computed from this channel&rsquo;s own recorded snapshots -- never a live
                      YouTube call. &ldquo;insufficient_history&rdquo; is the expected, honest
                      result until enough snapshots have accumulated over real days.
                    </InfoTooltip>
                  </p>
                  {intelligenceLoading && <p className="text-xs text-zinc-500">Loading...</p>}
                  {!intelligenceLoading && intelligenceError && <p className="text-xs text-red-400">{intelligenceError}</p>}
                  {!intelligenceLoading && intelligence && (
                    <div className="space-y-2 text-xs text-zinc-400">
                      {intelligence.dataQualityFlags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {intelligence.dataQualityFlags.map((flag) => (
                            <span key={flag} className="rounded-full border border-amber-800 bg-amber-950/40 px-2 py-0.5 text-amber-400">
                              {flag}
                            </span>
                          ))}
                        </div>
                      )}

                      {intelligence.channelSnapshots.length > 0 ? (
                        (() => {
                          const latest = intelligence.channelSnapshots[intelligence.channelSnapshots.length - 1];
                          // hiddenSubscriberCount is an explicit boolean (9A), never inferred from
                          // subscriberCount === null -- a null for some other reason (e.g. no data
                          // yet) must not be mislabeled "hidden" (AC-9A-09b's own distinction).
                          const subscriberDisplay =
                            latest.subscriberCount !== null
                              ? latest.subscriberCount
                              : latest.hiddenSubscriberCount
                                ? "hidden by channel"
                                : "—";
                          return (
                            <p>
                              Last observed {formatDisplayDateTime(latest.observedAt)} &middot; subscribers: {subscriberDisplay} &middot; views:{" "}
                              {latest.viewCount ?? "—"} &middot; videos: {latest.videoCount ?? "—"}
                            </p>
                          );
                        })()
                      ) : (
                        <p>No channel snapshots recorded yet.</p>
                      )}

                      <p>
                        Subscriber velocity:{" "}
                        {formatFieldVelocity(intelligence.subscriberVelocity, "subscribers", intelligence.methodology.channelVelocityWindowDays)}
                      </p>
                      <p>
                        Upload cadence:{" "}
                        {formatFieldVelocity(intelligence.uploadCadence, "videos", intelligence.methodology.channelVelocityWindowDays)}
                      </p>

                      <div>
                        <p className="text-zinc-300">
                          Recent relative performance (videos published in the last {intelligence.methodology.recentVideoWindowDays} days,
                          compared at day {intelligence.methodology.channelBaselineDayOffset} vs. every OTHER recent video&rsquo;s own median --
                          never including a video in its own baseline):
                        </p>
                        <p className="text-[11px] text-zinc-600">
                          A video needs at least {intelligence.methodology.breakoutMinBaselineSampleSize} OTHER recent videos with their own
                          usable day-{intelligence.methodology.channelBaselineDayOffset} data before any verdict is possible ({" "}
                          {intelligence.methodology.breakoutMinBaselineSampleSize + 1} recent videos minimum in total), and each video&rsquo;s
                          own day-{intelligence.methodology.channelBaselineDayOffset} point only exists if a collection run happened to land
                          within {intelligence.methodology.breakoutBaselineToleranceDays} days of that mark -- collection only runs when this
                          dashboard is opened, so a channel checked on rarely will show &ldquo;insufficient history&rdquo; more often, not because
                          it lacks activity.
                        </p>
                        {intelligence.recentBreakoutVideos.length === 0 && <p>No eligible recent videos yet.</p>}
                        {intelligence.recentBreakoutVideos.map((v) => (
                          <p key={v.videoId} className={v.isBreakout ? "text-emerald-400" : ""}>
                            {v.videoId}: {v.reason}
                          </p>
                        ))}
                        <p className="mt-1 text-zinc-300">
                          Emerging channel: {intelligence.emergingChannel.isEmerging ? "yes" : "no"}
                          {intelligence.emergingChannel.reasons.length > 0 && ` -- ${intelligence.emergingChannel.reasons.join("; ")}`}
                        </p>
                      </div>

                      <div>
                        <p className="mb-1 text-zinc-300">Videos (drill-down for full history):</p>
                        {intelligence.latestSnapshotPerVideo.length === 0 && <p>No video snapshots recorded yet.</p>}
                        {intelligence.latestSnapshotPerVideo.map((v) => (
                          <div key={v.videoId} className="border-t border-zinc-800 pt-1">
                            <button onClick={() => handleToggleVideoHistory(c.channelId, v.videoId)} className="text-left hover:text-zinc-200">
                              {v.videoId} &middot; views: {v.viewCount ?? "—"} &middot; last observed {formatDisplayDateTime(v.observedAt)}
                            </button>
                            {expandedVideoId === v.videoId && (
                              <div className="ml-3 mt-1 space-y-0.5">
                                {videoHistoryLoading && <p>Loading history...</p>}
                                {!videoHistoryLoading && videoHistoryError && <p className="text-red-400">{videoHistoryError}</p>}
                                {!videoHistoryLoading &&
                                  videoHistory.map((snap, i) => (
                                    <p key={i}>
                                      {formatDisplayDateTime(snap.observedAt)}: views {snap.viewCount ?? "—"}, likes {snap.likeCount ?? "—"},
                                      comments {snap.commentCount ?? "—"}
                                    </p>
                                  ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={handleFetchPublicSnapshot}
                  disabled={fetchingSnapshot}
                  className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {fetchingSnapshot ? "Fetching..." : "Fetch public snapshot"}
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <label className="col-span-2 block">
                    <span className="text-xs text-zinc-400">Observation</span>
                    <input
                      value={newObservation}
                      onChange={(ev) => setNewObservation(ev.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-zinc-400">Source</span>
                    <input
                      value={newSource}
                      onChange={(ev) => setNewSource(ev.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-zinc-400">Confidence (optional)</span>
                    <input
                      value={newConfidence}
                      onChange={(ev) => setNewConfidence(ev.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
                    />
                  </label>
                </div>
                {evidenceError && <p className="text-sm text-red-400">{evidenceError}</p>}
                <button
                  onClick={handleRecordEvidence}
                  disabled={recordingEvidence}
                  className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {recordingEvidence ? "Recording..." : "Record evidence"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {removeTarget && (
        <ConfirmDialog
          title="Remove from watchlist?"
          description={`This removes "${removeTarget.handleOrUrl ?? removeTarget.channelId}" and every evidence row recorded against it. This cannot be undone.`}
          confirmLabel={removing ? "Removing..." : "Remove"}
          confirmVariant="danger"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={handleConfirmRemove}
        />
      )}
    </div>
  );
}
