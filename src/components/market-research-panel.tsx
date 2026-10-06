"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment, useMarketAssignments, VisibleToPill } from "./market-channel-assignment";
import { MarketChannelCollectionDepth } from "./market-channel-collection-depth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { BlockingDialog } from "./blocking-dialog";
import { DrawerSection, SideDrawer } from "./side-drawer";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";

type ResearchEvidence = {
  evidenceId: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  collectedAt: string;
};

// BL-140 R3 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.3): mirrors getWatchlistTable's row.
type ChannelStatus = "current" | "attention" | "failed" | "never_collected";
type WatchlistRow = {
  channelId: string;
  handleOrUrl: string | null;
  reason: string;
  addedAt: string;
  latestObservation: {
    observedAt: string;
    subscriberCount: number | null;
    hiddenSubscriberCount: boolean;
    viewCount: number | null;
    videoCount: number | null;
  } | null;
  videosObserved: number;
  latestRun: { status: "success" | "skipped_quota_limited" | "failed"; ranAt: string | null } | null;
  dataQualityFlags: string[];
  status: ChannelStatus;
};

type RecentVideo = { videoId: string; title: string | null; publishedAt: string | null; viewCount: number | null; observedAt: string };

/** "needs_attention" is every status but "current" -- the same set the summary line's warning count covers. */
export type WatchlistStatusFilter = "" | "needs_attention" | ChannelStatus;

export const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  current: "Up to date",
  attention: "Stale or partial",
  failed: "Collection failed",
  never_collected: "Never collected",
};

const STATUS_PILL: Record<ChannelStatus, string> = {
  current: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  attention: "border-amber-800 bg-amber-950/40 text-amber-300",
  failed: "border-red-800 bg-red-950/40 text-red-300",
  never_collected: "border-zinc-700 bg-zinc-800 text-zinc-400",
};

const RECENT_VIDEOS = 20;
const inputClass = "rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200";

/** The table's search, status and "visible to" filters. Exported for its test. */
export function filterWatchlistRows(
  rows: WatchlistRow[],
  filters: { query: string; status: WatchlistStatusFilter; visibleTo: string; assignments: Map<string, string[]> }
): WatchlistRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query && ![row.handleOrUrl ?? "", row.channelId, row.reason].some((text) => text.toLowerCase().includes(query))) return false;
    if (filters.status === "needs_attention" ? row.status === "current" : filters.status && row.status !== filters.status) return false;
    if (filters.visibleTo && !(filters.assignments.get(row.channelId) ?? []).includes(filters.visibleTo)) return false;
    return true;
  });
}

// hiddenSubscriberCount is an explicit boolean (9A), never inferred from subscriberCount === null -- a null for some
// other reason (e.g. no data yet) must not be mislabeled "hidden" (AC-9A-09b's own distinction).
function formatSubscribers(observation: NonNullable<WatchlistRow["latestObservation"]>): string {
  if (observation.subscriberCount !== null) return observation.subscriberCount.toLocaleString("en-US");
  return observation.hiddenSubscriberCount ? "hidden by channel" : "—";
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

// Phase 9 slices 2-3 (docs/roadmap/plans/PHASE_9_PLAN.md) -- global (not channel-scoped) market research watchlist,
// shown since BL-140 R3 as a table with a side panel per channel. Adding a channel and recording evidence are both
// operator-entered; "Fetch public snapshot" is the one action here that makes a real outbound YouTube API call, and it
// asks first.
export function MarketResearchPanel({
  onShowVideos,
  statusFilterRequest,
}: {
  /** "Show all in Videos": open the Videos sub-tab filtered to this channel. */
  onShowVideos?: (channelId: string) => void;
  /** A status filter set from outside (the summary line's warning link); a new nonce re-applies the same status. */
  statusFilterRequest?: { status: WatchlistStatusFilter; nonce: number } | null;
} = {}) {
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WatchlistStatusFilter>(statusFilterRequest?.status ?? "");
  const [visibleTo, setVisibleTo] = useState("");
  // A new request from outside replaces the filter. Adjusted during render (the Videos panel's channelFilter pattern).
  const [lastStatusRequest, setLastStatusRequest] = useState(statusFilterRequest ?? null);
  if ((statusFilterRequest ?? null) !== lastStatusRequest) {
    setLastStatusRequest(statusFilterRequest ?? null);
    if (statusFilterRequest) setStatusFilter(statusFilterRequest.status);
  }

  // "Visible to agents of" -- one read for every row's pill instead of one per row.
  const { assignments, connectedChannels, set: setAssignment } = useMarketAssignments("research_channel");

  const [addOpen, setAddOpen] = useState(false);
  const [newChannelId, setNewChannelId] = useState("");
  const [newHandleOrUrl, setNewHandleOrUrl] = useState("");
  const [newReason, setNewReason] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  // Tracks which channel the most recently STARTED fetch was for, so a slower, now-stale response never overwrites a
  // newer one that already landed (found by independent code review -- the identical race already fixed in
  // market-trends-panel.tsx/market-topics-panel.tsx, tracked as RISK-77 for not yet sharing one hook across all three).
  const drawerRequestChannelIdRef = useRef<string | null>(null);

  const [recentVideos, setRecentVideos] = useState<RecentVideo[] | null>(null);
  const [recentVideosTotal, setRecentVideosTotal] = useState(0);
  const [recentVideosError, setRecentVideosError] = useState<string | null>(null);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [videoHistory, setVideoHistory] = useState<{ observedAt: string; viewCount: number | null; likeCount: number | null; commentCount: number | null }[]>([]);
  const [videoHistoryLoading, setVideoHistoryLoading] = useState(false);
  const [videoHistoryError, setVideoHistoryError] = useState<string | null>(null);
  const videoHistoryRequestIdRef = useRef<string | null>(null);

  const [newObservation, setNewObservation] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newConfidence, setNewConfidence] = useState("");
  const [recordingEvidence, setRecordingEvidence] = useState(false);
  const [confirmSnapshot, setConfirmSnapshot] = useState(false);
  const [fetchingSnapshot, setFetchingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WatchlistRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch("/api/market-intelligence/watchlist-table");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.message ?? "Failed to load the watchlist");
        return;
      }
      setLoadError(null);
      setRows(data.channels ?? []);
    } catch {
      setLoadError("Failed to load the watchlist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const visibleRows = useMemo(
    () => filterWatchlistRows(rows, { query, status: statusFilter, visibleTo, assignments }),
    [rows, query, statusFilter, visibleTo, assignments]
  );
  const selected = rows.find((row) => row.channelId === selectedChannelId) ?? null;

  const fetchEvidence = useCallback(async (channelId: string) => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/evidence`);
      const data = await res.json();
      if (drawerRequestChannelIdRef.current !== channelId) return;
      if (!res.ok) {
        setEvidenceError(data.message ?? "Failed to load evidence");
        return;
      }
      setEvidence(data.evidence ?? []);
    } finally {
      if (drawerRequestChannelIdRef.current === channelId) setEvidenceLoading(false);
    }
  }, []);

  const fetchRecentVideos = useCallback(async (channelId: string) => {
    setRecentVideos(null);
    setRecentVideosError(null);
    const params = new URLSearchParams({ page: "1", limit: String(RECENT_VIDEOS), sort: "published", channelId });
    try {
      const res = await fetch(`/api/market-intelligence/videos-overview?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (drawerRequestChannelIdRef.current !== channelId) return;
      if (!res.ok) {
        setRecentVideosError(data.message ?? "Failed to load videos");
        return;
      }
      setRecentVideos(data.rows ?? []);
      setRecentVideosTotal(data.total ?? 0);
    } catch {
      if (drawerRequestChannelIdRef.current === channelId) setRecentVideosError("Failed to load videos");
    }
  }, []);

  function resetDrawerState() {
    setEvidence([]);
    setEvidenceError(null);
    setRecentVideos(null);
    setRecentVideosError(null);
    setExpandedVideoId(null);
    setVideoHistory([]);
    setVideoHistoryError(null);
    setSnapshotError(null);
    setRemoveError(null);
    // Not just the state -- the stale-response guard refs too (found by independent code review), or an in-flight
    // fetch for a closed or removed channel can still pass its own guard and write into state.
    drawerRequestChannelIdRef.current = null;
    videoHistoryRequestIdRef.current = null;
  }

  function openDrawer(channelId: string) {
    resetDrawerState();
    drawerRequestChannelIdRef.current = channelId;
    setSelectedChannelId(channelId);
    void fetchEvidence(channelId);
    void fetchRecentVideos(channelId);
  }

  const closeDrawer = useCallback(() => {
    setSelectedChannelId(null);
    drawerRequestChannelIdRef.current = null;
    videoHistoryRequestIdRef.current = null;
  }, []);

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

  function closeAddDialog() {
    setAddOpen(false);
    setAddError(null);
  }

  async function handleAddToWatchlist() {
    setAddError(null);
    if (!newChannelId || !newReason) {
      setAddError("Channel id and reason are required");
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
        // The route's own `validation_failed` DomainError carries a generic top-level `message`
        // ("Invalid add to watchlist input") -- the actual per-field reason (e.g. "channelId must
        // be a valid YouTube channel id") only lives in `details` (parseWithSchema's formatted
        // Zod issues), which this panel previously discarded, leaving the operator with no way to
        // tell what was actually wrong (found via live testing, owner report 2026-09-29).
        const fieldMessages = Array.isArray(data.details)
          ? data.details
              .map((issue: { message?: unknown }) =>
                typeof issue.message === "string" ? issue.message : null
              )
              .filter((message: string | null): message is string => message !== null)
          : [];
        setAddError(
          fieldMessages.length > 0
            ? fieldMessages.join("; ")
            : (data.message ?? "Failed to add channel to the watchlist")
        );
        return;
      }
      setNewChannelId("");
      setNewHandleOrUrl("");
      setNewReason("");
      closeAddDialog();
      await fetchRows();
    } finally {
      setAdding(false);
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(removeTarget.channelId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRemoveError(data.message ?? "Failed to remove channel from the watchlist");
        return;
      }
      if (selectedChannelId === removeTarget.channelId) {
        resetDrawerState();
        setSelectedChannelId(null);
      }
      await fetchRows();
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  }

  async function handleFetchPublicSnapshot() {
    setConfirmSnapshot(false);
    const channelId = selectedChannelId;
    if (!channelId) return;
    setSnapshotError(null);
    setFetchingSnapshot(true);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/fetch-public-snapshot`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setSnapshotError(data.message ?? "Failed to fetch a public snapshot");
        return;
      }
      await Promise.all([fetchRows(), fetchEvidence(channelId)]);
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

  const filtered = query.trim() !== "" || statusFilter !== "" || visibleTo !== "";

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
            Watchlist
            <InfoTooltip>
              Channels you track for market context. You add them by hand or approve an agent&rsquo;s request; nothing
              here is private analytics of a channel you don&rsquo;t own. Per YouTube API policy, data about other
              people&rsquo;s channels is kept for 30 days (refreshed by collection) and nothing is derived from it
              &mdash; only the observed values, each with its date.
            </InfoTooltip>
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        >
          Add channel
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Watchlist filters">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search channels" aria-label="Search channels" className={`${inputClass} w-56`} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as WatchlistStatusFilter)} aria-label="Status" className={inputClass}>
          <option value="">Any status</option>
          <option value="needs_attention">Needs attention</option>
          {(Object.keys(CHANNEL_STATUS_LABELS) as ChannelStatus[]).map((status) => (
            <option key={status} value={status}>{CHANNEL_STATUS_LABELS[status]}</option>
          ))}
        </select>
        {connectedChannels.length > 0 && (
          <select value={visibleTo} onChange={(e) => setVisibleTo(e.target.value)} aria-label="Visible to" className={inputClass}>
            <option value="">Visible to anyone</option>
            {connectedChannels.map((c) => (
              <option key={c.channelId} value={c.channelId}>Visible to {c.title}</option>
            ))}
          </select>
        )}
        {!loading && rows.length > 0 && (
          <span className="text-xs text-zinc-500">
            {filtered ? `${visibleRows.length} of ${rows.length}` : `${rows.length}`} channel{rows.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading && <LoadingIndicator className="text-sm text-zinc-500" />}
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && <p className="text-sm text-zinc-500">No channels on the watchlist yet.</p>}
      {!loading && rows.length > 0 && visibleRows.length === 0 && <p className="text-sm text-zinc-500">No channels match these filters.</p>}

      {visibleRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="pb-1 pr-3 font-medium">Channel</th>
                <th className="pb-1 pr-3 font-medium">Reason</th>
                <th className="pb-1 pr-3 font-medium">Subscribers (as of)</th>
                <th className="pb-1 pr-3 font-medium">Videos observed</th>
                <th className="pb-1 pr-3 font-medium">Last collected</th>
                <th className="pb-1 pr-3 font-medium">Status</th>
                <th className="pb-1 font-medium">Visible to</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.channelId}
                  onClick={() => openDrawer(row.channelId)}
                  className={`cursor-pointer border-t border-zinc-800 align-top hover:bg-zinc-800/50 ${row.channelId === selectedChannelId ? "bg-zinc-800/50" : ""}`}
                >
                  <td className="max-w-[14rem] py-1.5 pr-3">
                    <button type="button" className="block max-w-full truncate text-left font-medium text-zinc-200 hover:underline">
                      {row.handleOrUrl ?? row.channelId}
                    </button>
                    {row.handleOrUrl && <span className="block truncate text-[11px] text-zinc-600">{row.channelId}</span>}
                  </td>
                  <td className="max-w-[16rem] truncate py-1.5 pr-3 text-zinc-400" title={row.reason}>{row.reason}</td>
                  <td className="py-1.5 pr-3 text-zinc-400">
                    {row.latestObservation ? (
                      <>
                        {formatSubscribers(row.latestObservation)}{" "}
                        <span className="whitespace-nowrap text-zinc-600">({formatDisplayDateTime(row.latestObservation.observedAt)})</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-400">{row.videosObserved.toLocaleString("en-US")}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-zinc-400">{row.latestRun?.ranAt ? formatDisplayDateTime(row.latestRun.ranAt) : "—"}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 ${STATUS_PILL[row.status]}`}>{CHANNEL_STATUS_LABELS[row.status]}</span>
                  </td>
                  <td className="py-1.5">
                    <VisibleToPill channelIds={assignments.get(row.channelId) ?? []} connectedChannels={connectedChannels} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SideDrawer
          title={selected.handleOrUrl ?? selected.channelId}
          subtitle={
            <>
              {selected.channelId} · added {formatDisplayDateTime(selected.addedAt)}
              <span className="mt-1 block text-zinc-400">{selected.reason}</span>
            </>
          }
          onClose={closeDrawer}
        >
          <DrawerSection title="Latest observation">
            <div className="space-y-1 text-xs text-zinc-400">
              <p>
                <span className={`rounded-full border px-2 py-0.5 ${STATUS_PILL[selected.status]}`}>{CHANNEL_STATUS_LABELS[selected.status]}</span>
                {selected.dataQualityFlags.length > 0 && <span className="ml-2 text-zinc-500">{selected.dataQualityFlags.join(", ")}</span>}
              </p>
              {selected.latestObservation ? (
                <p>
                  Observed {formatDisplayDateTime(selected.latestObservation.observedAt)} &middot; subscribers: {formatSubscribers(selected.latestObservation)}{" "}
                  &middot; views: {formatCount(selected.latestObservation.viewCount)} &middot; videos: {formatCount(selected.latestObservation.videoCount)}
                </p>
              ) : (
                <p>No channel snapshot recorded yet.</p>
              )}
              <p>
                Last collection: {selected.latestRun ? `${selected.latestRun.status}${selected.latestRun.ranAt ? `, ${formatDisplayDateTime(selected.latestRun.ranAt)}` : ""}` : "never"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmSnapshot(true)}
              disabled={fetchingSnapshot}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {fetchingSnapshot ? "Fetching..." : "Fetch public snapshot"}
            </button>
            {snapshotError && <p className="text-xs text-red-400">{snapshotError}</p>}
          </DrawerSection>

          <DrawerSection title={`Recent videos${recentVideos && recentVideosTotal > 0 ? ` (${Math.min(recentVideos.length, recentVideosTotal)} of ${recentVideosTotal})` : ""}`}>
            {recentVideos === null && !recentVideosError && <LoadingIndicator className="text-xs text-zinc-500" />}
            {recentVideosError && <p className="text-xs text-red-400">{recentVideosError}</p>}
            {recentVideos && recentVideos.length === 0 && <p className="text-xs text-zinc-500">No video snapshots recorded yet.</p>}
            {recentVideos && recentVideos.length > 0 && (
              <div className="space-y-1 text-xs text-zinc-400">
                {recentVideos.map((v) => (
                  <div key={v.videoId} className="border-t border-zinc-800 pt-1">
                    <button type="button" onClick={() => handleToggleVideoHistory(selected.channelId, v.videoId)} className="text-left hover:text-zinc-200">
                      <span className="text-zinc-200">{v.title ?? v.videoId}</span> &middot; views {formatCount(v.viewCount)} (as of{" "}
                      {formatDisplayDateTime(v.observedAt)})
                    </button>
                    {expandedVideoId === v.videoId && (
                      <div className="ml-3 mt-1 space-y-0.5">
                        {videoHistoryLoading && <p>Loading history...</p>}
                        {!videoHistoryLoading && videoHistoryError && <p className="text-red-400">{videoHistoryError}</p>}
                        {!videoHistoryLoading &&
                          videoHistory.map((snap, i) => (
                            <p key={i}>
                              {formatDisplayDateTime(snap.observedAt)}: views {formatCount(snap.viewCount)}, likes {formatCount(snap.likeCount)}, comments{" "}
                              {formatCount(snap.commentCount)}
                            </p>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {onShowVideos && recentVideosTotal > 0 && (
              <button
                type="button"
                onClick={() => {
                  onShowVideos(selected.channelId);
                  closeDrawer();
                }}
                className="text-xs text-indigo-300 hover:text-indigo-200"
              >
                Show all in Videos →
              </button>
            )}
          </DrawerSection>

          <DrawerSection title="Evidence">
            {evidenceLoading && <p className="text-xs text-zinc-500">Loading evidence...</p>}
            {!evidenceLoading && evidence.length === 0 && <p className="text-xs text-zinc-500">No evidence recorded yet for this channel.</p>}
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
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 block">
                <span className="text-xs text-zinc-400">Observation</span>
                <input value={newObservation} onChange={(ev) => setNewObservation(ev.target.value)} className={`mt-1 w-full ${inputClass}`} />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Source</span>
                <input value={newSource} onChange={(ev) => setNewSource(ev.target.value)} className={`mt-1 w-full ${inputClass}`} />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Confidence (optional)</span>
                <input value={newConfidence} onChange={(ev) => setNewConfidence(ev.target.value)} className={`mt-1 w-full ${inputClass}`} />
              </label>
            </div>
            {evidenceError && <p className="text-xs text-red-400">{evidenceError}</p>}
            <button
              type="button"
              onClick={handleRecordEvidence}
              disabled={recordingEvidence}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {recordingEvidence ? "Recording..." : "Record evidence"}
            </button>
          </DrawerSection>

          <DrawerSection title="Collection depth">
            <FeatureErrorBoundary label="Collection depth">
              <MarketChannelCollectionDepth channelId={selected.channelId} />
            </FeatureErrorBoundary>
          </DrawerSection>

          <DrawerSection title="Visible to agents of">
            <FeatureErrorBoundary label="Channel assignment">
              <MarketChannelAssignment
                recordKind="research_channel"
                recordId={selected.channelId}
                onChange={(channelIds) => setAssignment(selected.channelId, channelIds)}
              />
            </FeatureErrorBoundary>
          </DrawerSection>

          <DrawerSection title="Remove">
            <button
              type="button"
              onClick={() => setRemoveTarget(selected)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-800"
            >
              Remove from watchlist
            </button>
            {removeError && <p className="text-xs text-red-400">{removeError}</p>}
          </DrawerSection>
        </SideDrawer>
      )}

      {addOpen && (
        <BlockingDialog label="Add a channel to the watchlist" busy={adding}>
          <p className="text-sm font-medium text-zinc-100">Add a channel to the watchlist</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-zinc-400">YouTube channel id (e.g. UC...)</span>
              <input value={newChannelId} onChange={(e) => setNewChannelId(e.target.value)} className={`mt-1 w-full ${inputClass}`} autoFocus />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-400">Handle/URL (optional, informational only)</span>
              <input value={newHandleOrUrl} onChange={(e) => setNewHandleOrUrl(e.target.value)} className={`mt-1 w-full ${inputClass}`} />
            </label>
            <label className="col-span-2 block">
              <span className="text-xs text-zinc-400">Reason for tracking this channel</span>
              <input value={newReason} onChange={(e) => setNewReason(e.target.value)} className={`mt-1 w-full ${inputClass}`} />
            </label>
          </div>
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeAddDialog}
              disabled={adding}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAddToWatchlist}
              disabled={adding}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {adding ? "Adding..." : "Add to watchlist"}
            </button>
          </div>
        </BlockingDialog>
      )}

      {confirmSnapshot && (
        <ConfirmDialog
          title="Fetch a public snapshot now?"
          description="This makes one YouTube Data API call (channels.list, 1 quota unit) for this channel and records its current public counts."
          confirmLabel="Fetch"
          onCancel={() => setConfirmSnapshot(false)}
          onConfirm={handleFetchPublicSnapshot}
        />
      )}

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
