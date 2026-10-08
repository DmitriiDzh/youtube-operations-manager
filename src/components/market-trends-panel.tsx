"use client";

import { errorText } from "@/lib/ui-text";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment, useMarketAssignments, VisibleToPill } from "./market-channel-assignment";
import { BlockingDialog } from "./blocking-dialog";
import { DrawerSection, SideDrawer } from "./side-drawer";
import { useCallback, useEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

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

const STATUS_LABELS: Record<TrendCandidateStatus, UiTextKey> = {
  emerging: "trends.status.emerging",
  growing: "trends.status.growing",
  established: "trends.status.established",
  declining: "trends.status.declining",
  stale: "trends.status.stale",
};

const EVIDENCE_TYPE_LABELS: Record<TrendEvidenceType, UiTextKey> = {
  signal: "trends.evidenceType.signal",
  supporting_channel: "trends.evidenceType.supporting_channel",
  supporting_video: "trends.evidenceType.supporting_video",
};

// Phase 9 slice 9E, part B (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md §14) -- manual/structural
// trend candidates. Creation always requires at least one evidence item, and any status change
// requires a reason (written as its own evidence row) -- both enforced by the service layer, this
// component only surfaces the required fields. BL-140 R5: a list with a status filter; a candidate's evidence, status
// change and visibility open in a side panel, and the add form in a dialog.
export function MarketTrendsPanel() {
  const t = useT();
  const [trendCandidates, setTrendCandidates] = useState<MarketTrendCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TrendCandidateStatus | "">("");
  const [addOpen, setAddOpen] = useState(false);
  const { assignments: visibility, connectedChannels, set: setVisibility } = useMarketAssignments("trend_candidate");

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

  const closeTrend = useCallback(() => {
    setExpandedTrendId(null);
    // The stale-response guard too, so a late reply for the closed candidate is dropped.
    evidenceRequestTrendIdRef.current = null;
  }, []);

  function handleOpen(trendCandidate: MarketTrendCandidate) {
    setEvidence([]);
    setIndependentChannelCount(0);
    setStatusChoice(trendCandidate.status);
    setStatusReason("");
    setExpandedTrendId(trendCandidate.trendCandidateId);
    setStatusError(null);
    setAddEvidenceError(null);
    void fetchEvidence(trendCandidate.trendCandidateId);
  }

  const visibleTrends = statusFilter ? trendCandidates.filter((trend) => trend.status === statusFilter) : trendCandidates;
  const openTrend = trendCandidates.find((trend) => trend.trendCandidateId === expandedTrendId) ?? null;

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
        setCreateError(errorText(t, data, t("trends.createFailed"), { showErrorField: false }));
        return;
      }
      setNewTitle("");
      setNewDescription("");
      setNewEvidenceRef("");
      setNewEvidenceDescription("");
      setAddOpen(false);
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
        setStatusError(errorText(t, data, t("trends.updateStatusFailed"), { showErrorField: false }));
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
        setAddEvidenceError(errorText(t, data, t("trends.recordEvidenceFailed"), { showErrorField: false }));
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("trends.title")}
          <InfoTooltip>{t("trends.info")}</InfoTooltip>
        </h3>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        >
          {t("trends.add")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label={t("trends.filtersLabel")}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TrendCandidateStatus | "")} aria-label={t("trends.statusLabel")} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200">
          <option value="">{t("trends.anyStatus")}</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {t("trends.statusOption", { status: t(STATUS_LABELS[option]), count: trendCandidates.filter((trend) => trend.status === option).length })}
            </option>
          ))}
        </select>
      </div>

      {addOpen && (
        <BlockingDialog label={t("trends.addDialogTitle")} busy={creating}>
          <p className="text-sm font-medium text-zinc-100">{t("trends.addDialogTitle")}</p>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t("trends.titlePlaceholder")}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
          />
          <input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder={t("trends.descriptionPlaceholder")}
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
                  {t(EVIDENCE_TYPE_LABELS[option])}
                </option>
              ))}
            </select>
            {newEvidenceType !== "signal" && (
              <input
                value={newEvidenceRef}
                onChange={(e) => setNewEvidenceRef(e.target.value)}
                placeholder={newEvidenceType === "supporting_channel" ? t("trends.channelIdPlaceholder") : t("trends.videoIdPlaceholder")}
                className="min-w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              />
            )}
            <input
              value={newEvidenceDescription}
              onChange={(e) => setNewEvidenceDescription(e.target.value)}
              placeholder={t("trends.initialEvidencePlaceholder")}
              className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
            />
          </div>
          {createError && <p className="text-xs text-red-400">{createError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setCreateError(null);
              }}
              disabled={creating}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || newTitle.trim().length === 0 || newEvidenceDescription.trim().length === 0}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {creating ? t("trends.adding") : t("trends.addCandidate")}
            </button>
          </div>
        </BlockingDialog>
      )}

      {!loading && trendCandidates.length === 0 && <p className="text-sm text-zinc-500">{t("trends.empty")}</p>}
      {!loading && trendCandidates.length > 0 && visibleTrends.length === 0 && <p className="text-sm text-zinc-500">{t("trends.emptyFiltered")}</p>}

      {visibleTrends.length > 0 && (
        <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {visibleTrends.map((trendCandidate) => (
            <button
              key={trendCandidate.trendCandidateId}
              type="button"
              onClick={() => handleOpen(trendCandidate)}
              className={`block w-full px-3 py-2 text-left hover:bg-zinc-800/50 ${expandedTrendId === trendCandidate.trendCandidateId ? "bg-zinc-800/50" : ""}`}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100">{trendCandidate.title}</span>
                <span className="flex items-center gap-2 text-xs">
                  <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">{t(STATUS_LABELS[trendCandidate.status])}</span>
                  <VisibleToPill channelIds={visibility.get(trendCandidate.trendCandidateId) ?? []} connectedChannels={connectedChannels} />
                </span>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-600">
                {t("trends.lastObserved", { date: formatDisplayDateTime(trendCandidate.lastObservedAt) })}
                <span
                  className={
                    trendCandidate.freshness === "fresh"
                      ? "rounded-full border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-400"
                      : "rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-500"
                  }
                >
                  {trendCandidate.freshness === "fresh" ? t("trends.freshRecent") : t("trends.freshNone")}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {openTrend && (
        <SideDrawer
          title={openTrend.title}
          subtitle={t("trends.drawerSubtitle", {
            status: t(STATUS_LABELS[openTrend.status]),
            first: formatDisplayDateTime(openTrend.firstObservedAt),
            last: formatDisplayDateTime(openTrend.lastObservedAt),
          })}
          onClose={closeTrend}
        >
          {openTrend.description && <p className="text-sm text-zinc-400">{openTrend.description}</p>}
          <DrawerSection title={t("trends.evidenceAndStatus")}>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-400">
                {evidence.length > 0 ? t("trends.evidenceWithChannels", { count: independentChannelCount }) : t("trends.evidence")}
              </p>
              {evidenceLoading && <LoadingIndicator className="text-xs text-zinc-500" />}
              {!evidenceLoading && evidence.length === 0 && <p className="text-xs text-zinc-500">{t("trends.noEvidence")}</p>}
              {!evidenceLoading && evidence.some((row) => row.evidenceType === "supporting_video") && (
                <div className="mb-2">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">{t("trends.representativeVideos")}</p>
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
                      <span className="text-zinc-500">[{t(EVIDENCE_TYPE_LABELS[row.evidenceType])}]</span> {row.description}
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
                    {t(EVIDENCE_TYPE_LABELS[option])}
                  </option>
                ))}
              </select>
              {addEvidenceType !== "signal" && (
                <input
                  value={addEvidenceRef}
                  onChange={(e) => setAddEvidenceRef(e.target.value)}
                  placeholder={addEvidenceType === "supporting_channel" ? t("trends.channelIdPlaceholder") : t("trends.videoIdPlaceholder")}
                  className="min-w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                />
              )}
              <input
                value={addEvidenceDescription}
                onChange={(e) => setAddEvidenceDescription(e.target.value)}
                placeholder={t("trends.evidenceDescriptionPlaceholder")}
                className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              />
              <button
                onClick={() => handleAddEvidence(openTrend.trendCandidateId)}
                disabled={addingEvidence || addEvidenceDescription.trim().length === 0}
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {t("trends.addEvidence")}
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
                    {t(STATUS_LABELS[option])}
                  </option>
                ))}
              </select>
              <input
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                placeholder={t("trends.reasonPlaceholder")}
                className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              />
              <button
                onClick={() => handleUpdateStatus(openTrend.trendCandidateId)}
                disabled={updatingStatus || statusReason.trim().length === 0 || statusChoice === openTrend.status}
                className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {t("trends.changeStatus")}
              </button>
            </div>
            {statusError && <p className="text-xs text-red-400">{statusError}</p>}
          </DrawerSection>
          <DrawerSection title={t("requests.visibleTo")}>
            <FeatureErrorBoundary label={t("requests.channelAssignment")}>
              <MarketChannelAssignment
                recordKind="trend_candidate"
                recordId={openTrend.trendCandidateId}
                onChange={(channelIds) => setVisibility(openTrend.trendCandidateId, channelIds)}
              />
            </FeatureErrorBoundary>
          </DrawerSection>
        </SideDrawer>
      )}
    </div>
  );
}
