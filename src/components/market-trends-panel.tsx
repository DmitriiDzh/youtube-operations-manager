"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

type TrendCandidateStatus = "emerging" | "growing" | "established" | "declining" | "stale";
type TrendEvidenceType = "supporting_channel" | "supporting_video" | "signal";

type MarketTrendCandidate = {
  trendCandidateId: string;
  title: string;
  description: string | null;
  topicId: string | null;
  status: TrendCandidateStatus;
  firstObservedAt: string;
  lastObservedAt: string;
  // Phase 9 slice 9H, part A -- from listTrendCandidatesWithFreshness, never "stale" (that word is
  // already one of TrendCandidateStatus's own five lifecycle values, so a "growing" trend showing a
  // "stale" freshness badge would visibly contradict itself).
  freshness: "fresh" | "needs_attention";
};

type MarketTrendEvidence = {
  evidenceId: string;
  trendCandidateId: string;
  evidenceType: TrendEvidenceType;
  referenceId: string | null;
  description: string;
  recordedAt: string;
};

const STATUS_OPTIONS: TrendCandidateStatus[] = ["emerging", "growing", "established", "declining", "stale"];
const EVIDENCE_TYPE_OPTIONS: TrendEvidenceType[] = ["signal", "supporting_channel", "supporting_video"];

// Phase 9 slice 9E, part B (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md §14) -- manual/structural
// trend candidates. Creation always requires at least one evidence item, and any status change
// requires a reason (written as its own evidence row) -- both enforced by the service layer, this
// component only surfaces the required fields.
export function MarketTrendsPanel() {
  const [trendCandidates, setTrendCandidates] = useState<MarketTrendCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newEvidenceType, setNewEvidenceType] = useState<TrendEvidenceType>("signal");
  const [newEvidenceRef, setNewEvidenceRef] = useState("");
  const [newEvidenceDescription, setNewEvidenceDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [expandedTrendId, setExpandedTrendId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<MarketTrendEvidence[]>([]);
  const [independentChannelCount, setIndependentChannelCount] = useState(0);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  const [statusChoice, setStatusChoice] = useState<TrendCandidateStatus>("growing");
  const [statusReason, setStatusReason] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [addEvidenceType, setAddEvidenceType] = useState<TrendEvidenceType>("signal");
  const [addEvidenceRef, setAddEvidenceRef] = useState("");
  const [addEvidenceDescription, setAddEvidenceDescription] = useState("");
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [addEvidenceError, setAddEvidenceError] = useState<string | null>(null);
  // Tracks which trend candidate the most recently STARTED fetchEvidence call was for, so a
  // slower, now-stale response never overwrites a newer one that already landed (found by
  // independent code review -- the identical race already fixed in market-topics-panel.tsx).
  const evidenceRequestTrendIdRef = useRef<string | null>(null);

  const fetchTrendCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/market-intelligence/trend-candidates");
      if (res.ok) {
        const data = await res.json();
        setTrendCandidates(data.trendCandidates ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTrendCandidates();
  }, [fetchTrendCandidates]);

  const fetchEvidence = useCallback(async (trendCandidateId: string) => {
    evidenceRequestTrendIdRef.current = trendCandidateId;
    setEvidenceLoading(true);
    try {
      // Returns getTrendEvidenceSummary's own shape (newest-first evidence + independentChannelCount),
      // not the underlying core's own plain ascending-order evidence list (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §6).
      const res = await fetch(`/api/market-intelligence/trend-candidates/${encodeURIComponent(trendCandidateId)}/evidence`);
      if (res.ok) {
        const data = await res.json();
        if (evidenceRequestTrendIdRef.current === trendCandidateId) {
          setEvidence(data.evidence ?? []);
          setIndependentChannelCount(data.independentChannelCount ?? 0);
        }
      }
    } finally {
      if (evidenceRequestTrendIdRef.current === trendCandidateId) setEvidenceLoading(false);
    }
  }, []);

  function handleToggleExpand(trendCandidate: MarketTrendCandidate) {
    if (expandedTrendId === trendCandidate.trendCandidateId) {
      setExpandedTrendId(null);
      return;
    }
    setExpandedTrendId(trendCandidate.trendCandidateId);
    setStatusError(null);
    setAddEvidenceError(null);
    void fetchEvidence(trendCandidate.trendCandidateId);
  }

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/market-intelligence/trend-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: newTitle,
          description: newDescription.trim().length > 0 ? newDescription : undefined,
          initialEvidence: {
            evidenceType: newEvidenceType,
            referenceId: newEvidenceRef.trim().length > 0 ? newEvidenceRef.trim() : undefined,
            description: newEvidenceDescription,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.message ?? "Failed to create trend candidate");
        return;
      }
      setNewTitle("");
      setNewDescription("");
      setNewEvidenceRef("");
      setNewEvidenceDescription("");
      await fetchTrendCandidates();
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateStatus(trendCandidateId: string) {
    setUpdatingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/market-intelligence/trend-candidates/${encodeURIComponent(trendCandidateId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: statusChoice, reason: statusReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusError(data.message ?? "Failed to update status");
        return;
      }
      setStatusReason("");
      await fetchTrendCandidates();
      await fetchEvidence(trendCandidateId);
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleAddEvidence(trendCandidateId: string) {
    setAddingEvidence(true);
    setAddEvidenceError(null);
    try {
      const res = await fetch(`/api/market-intelligence/trend-candidates/${encodeURIComponent(trendCandidateId)}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evidenceType: addEvidenceType,
          referenceId: addEvidenceRef.trim().length > 0 ? addEvidenceRef.trim() : undefined,
          description: addEvidenceDescription,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddEvidenceError(data.message ?? "Failed to record evidence");
        return;
      }
      setAddEvidenceRef("");
      setAddEvidenceDescription("");
      await fetchEvidence(trendCandidateId);
      await fetchTrendCandidates();
    } finally {
      setAddingEvidence(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Trend candidates
          <InfoTooltip>
            A manually-declared list of emerging trends, each backed by at least one piece of
            evidence. Every status change requires a reason, recorded as its own evidence row --
            a status can never move without an explanation attached to it.
          </InfoTooltip>
        </h3>
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Trend title"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <input
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={newEvidenceType}
            onChange={(e) => {
              // Clearing the stale ref on every type change (not just hiding its input) --
              // otherwise switching from supporting_channel/video back to "signal" leaves a
              // non-empty referenceId in state, which the "signal" branch's own strict schema has
              // no key for at all and rejects outright (found by independent code review).
              setNewEvidenceType(e.target.value as TrendEvidenceType);
              setNewEvidenceRef("");
            }}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
          >
            {EVIDENCE_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {newEvidenceType !== "signal" && (
            <input
              value={newEvidenceRef}
              onChange={(e) => setNewEvidenceRef(e.target.value)}
              placeholder={newEvidenceType === "supporting_channel" ? "Channel id (UC...)" : "Video id"}
              className="min-w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
            />
          )}
          <input
            value={newEvidenceDescription}
            onChange={(e) => setNewEvidenceDescription(e.target.value)}
            placeholder="Initial evidence description"
            className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
          />
          <button
            onClick={handleCreate}
            disabled={creating || newTitle.trim().length === 0 || newEvidenceDescription.trim().length === 0}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {creating ? "Adding..." : "Add trend candidate"}
          </button>
        </div>
        {createError && <p className="text-sm text-red-400">{createError}</p>}
      </div>

      {!loading && trendCandidates.length === 0 && <p className="text-sm text-zinc-500">No trend candidates yet.</p>}

      <div className="space-y-2">
        {trendCandidates.map((trendCandidate) => (
          <div key={trendCandidate.trendCandidateId} className="rounded-lg border border-zinc-800 p-3">
            <button
              onClick={() => handleToggleExpand(trendCandidate)}
              className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
            >
              <span className="text-sm font-medium text-zinc-100">{trendCandidate.title}</span>
              <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">{trendCandidate.status}</span>
            </button>
            {trendCandidate.description && <p className="mt-1 text-xs text-zinc-500">{trendCandidate.description}</p>}
            <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-600">
              First seen {formatDisplayDateTime(trendCandidate.firstObservedAt)} &middot; last observed{" "}
              {formatDisplayDateTime(trendCandidate.lastObservedAt)}
              <span
                className={
                  trendCandidate.freshness === "fresh"
                    ? "rounded-full border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-400"
                    : "rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-500"
                }
              >
                {trendCandidate.freshness === "fresh" ? "evidence added recently" : "no recent evidence"}
              </span>
            </p>

            {expandedTrendId === trendCandidate.trendCandidateId && (
              <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-400">
                    Evidence {evidence.length > 0 && `(${independentChannelCount} independent channel${independentChannelCount === 1 ? "" : "s"})`}
                  </p>
                  {evidenceLoading && <p className="text-xs text-zinc-500">Loading...</p>}
                  {!evidenceLoading && evidence.length === 0 && <p className="text-xs text-zinc-500">No evidence yet.</p>}
                  {!evidenceLoading && evidence.some((row) => row.evidenceType === "supporting_video") && (
                    <div className="mb-2">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500">Representative videos</p>
                      <div className="space-y-1">
                        {evidence
                          .filter((row) => row.evidenceType === "supporting_video")
                          .map((row) => (
                            <div key={row.evidenceId} className="text-xs text-zinc-300">
                              {row.description}
                              {row.referenceId && <span className="text-zinc-500"> ({row.referenceId})</span>}
                              <span className="text-zinc-600"> &middot; {formatDisplayDateTime(row.recordedAt)}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                  <div className="space-y-1">
                    {evidence
                      .filter((row) => row.evidenceType !== "supporting_video")
                      .map((row) => (
                        <div key={row.evidenceId} className="text-xs text-zinc-300">
                          <span className="text-zinc-500">[{row.evidenceType}]</span> {row.description}
                          {row.referenceId && <span className="text-zinc-500"> ({row.referenceId})</span>}
                          <span className="text-zinc-600"> &middot; {formatDisplayDateTime(row.recordedAt)}</span>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={addEvidenceType}
                    onChange={(e) => {
                      setAddEvidenceType(e.target.value as TrendEvidenceType);
                      setAddEvidenceRef("");
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  >
                    {EVIDENCE_TYPE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  {addEvidenceType !== "signal" && (
                    <input
                      value={addEvidenceRef}
                      onChange={(e) => setAddEvidenceRef(e.target.value)}
                      placeholder={addEvidenceType === "supporting_channel" ? "Channel id (UC...)" : "Video id"}
                      className="min-w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                    />
                  )}
                  <input
                    value={addEvidenceDescription}
                    onChange={(e) => setAddEvidenceDescription(e.target.value)}
                    placeholder="Evidence description"
                    className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => handleAddEvidence(trendCandidate.trendCandidateId)}
                    disabled={addingEvidence || addEvidenceDescription.trim().length === 0}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Add evidence
                  </button>
                </div>
                {addEvidenceError && <p className="text-xs text-red-400">{addEvidenceError}</p>}

                <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2">
                  <select
                    value={statusChoice}
                    onChange={(e) => setStatusChoice(e.target.value as TrendCandidateStatus)}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <input
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    placeholder="Reason for this status change"
                    className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => handleUpdateStatus(trendCandidate.trendCandidateId)}
                    disabled={updatingStatus || statusReason.trim().length === 0}
                    className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                  >
                    Change status
                  </button>
                </div>
                {statusError && <p className="text-xs text-red-400">{statusError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
