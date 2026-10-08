"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment } from "./market-channel-assignment";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type MarketResearchRequestStatus = "pending" | "approved" | "rejected" | "executed" | "execution_failed";

type MarketResearchRequest = {
  requestId: string;
  query: string;
  rationale: string;
  monitorDurationDays: number | null;
  status: MarketResearchRequestStatus;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedReason: string | null;
  candidatesFound: number | null;
  candidatesNew: number | null;
  executionError: string | null;
};

const STATUS_LABELS: Record<MarketResearchRequestStatus, UiTextKey> = {
  pending: "requests.research.status.pending",
  approved: "requests.research.status.approved",
  rejected: "requests.research.status.rejected",
  executed: "requests.research.status.executed",
  execution_failed: "requests.research.status.execution_failed",
};

// Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §9) -- the ONLY
// place a research request can be approved or rejected. Approving spends real quota (one search.list call,
// 1 of YouTube's 100 daily searches) -- the approve action sits behind ConfirmDialog (never window.confirm, per
// this app's own standing UI convention) and states the cost explicitly before the operator
// commits.
/** `onChanged` runs after an approve or reject, so the summary line and badges follow at once (BL-140 review). */
export function MarketResearchRequestsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const t = useT();
  const [requests, setRequests] = useState<MarketResearchRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<MarketResearchRequest | null>(null);
  const [approving, setApproving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<MarketResearchRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/market-intelligence/research-requests");
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  async function handleConfirmApprove() {
    if (!approveTarget) return;
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-intelligence/research-requests/${encodeURIComponent(approveTarget.requestId)}/approve`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? t("requests.research.approveFailed"));
        return;
      }
      setApproveTarget(null);
      await fetchRequests();
      onChanged?.();
    } finally {
      setApproving(false);
    }
  }

  async function handleConfirmReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-intelligence/research-requests/${encodeURIComponent(rejectTarget.requestId)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: rejectReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? t("requests.rejectFailed"));
        return;
      }
      setRejectTarget(null);
      setRejectReason("");
      await fetchRequests();
      onChanged?.();
    } finally {
      setRejecting(false);
    }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const resolved = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("requests.research.title")}
          <InfoTooltip>{t("requests.research.info")}</InfoTooltip>
        </h3>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && pending.length === 0 && <p className="text-sm text-zinc-500">{t("requests.research.empty")}</p>}

      <div className="space-y-2">
        {pending.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
            <div className="mb-2">
              <FeatureErrorBoundary label={t("requests.channelAssignment")}>
                <MarketChannelAssignment recordKind="research_request" recordId={request.requestId} />
              </FeatureErrorBoundary>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-zinc-100">{request.query}</p>
                <p className="mt-1 text-xs text-zinc-400">{request.rationale}</p>
                {request.monitorDurationDays !== null && (
                  <p className="mt-1 text-xs text-zinc-500">{t("requests.research.monitoring", { count: request.monitorDurationDays })}</p>
                )}
                <p className="mt-1 text-xs text-zinc-600">
                  {request.agentApiVersion
                    ? t("requests.createdViaVersion", { via: request.createdVia, version: request.agentApiVersion })
                    : t("requests.createdVia", { via: request.createdVia })}{" "}
                  &middot;{" "}
                  {formatDisplayDateTime(request.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setApproveTarget(request)}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  {t("requests.approve")}
                </button>
                <button
                  onClick={() => setRejectTarget(request)}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-red-700 hover:text-red-400"
                >
                  {t("requests.reject")}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-xs font-medium text-zinc-500">{t("requests.history")}</p>
          {resolved.map((request) => (
            <div key={request.requestId} className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
              <span>
                {request.query} &middot; {t(STATUS_LABELS[request.status])}
                {request.status === "executed" && ` ${t("requests.research.executedCounts", { found: request.candidatesFound ?? 0, fresh: request.candidatesNew ?? 0 })}`}
                {request.status === "execution_failed" && request.executionError ? `: ${request.executionError}` : ""}
                {request.status === "rejected" && request.resolvedReason ? `: ${request.resolvedReason}` : ""}
              </span>
              <span className="text-zinc-600">{request.resolvedAt ? formatDisplayDateTime(request.resolvedAt) : ""}</span>
            </div>
          ))}
        </div>
      )}

      {approveTarget && (
        <ConfirmDialog
          title={t("requests.research.approveTitle")}
          description={t("requests.research.approveBody", { query: approveTarget.query })}
          confirmLabel={approving ? t("requests.research.approving") : t("requests.approve")}
          confirmVariant="danger"
          onCancel={() => setApproveTarget(null)}
          onConfirm={handleConfirmApprove}
        />
      )}

      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <h4 className="text-base font-semibold text-zinc-100">{t("requests.research.rejectTitle")}</h4>
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("requests.rejectReasonPlaceholder")}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason("");
                }}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleConfirmReject}
                disabled={rejecting || rejectReason.trim().length === 0}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rejecting ? t("requests.rejecting") : t("requests.reject")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
