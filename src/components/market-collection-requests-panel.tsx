"use client";

import { useCallback, useEffect, useState } from "react";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment } from "./market-channel-assignment";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { OperationOverlay, useOperation } from "./operation-progress";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";
import {
  OUTCOME_LABELS,
  budgetSentence,
  estimateSentence,
  runSummary,
  unitsText,
  type CollectionChannelResultView,
} from "./market-collection-requests-view";

type CollectionRequestStatus = "pending" | "approved" | "running" | "done" | "rejected" | "failed";

type CollectionRequest = {
  requestId: string;
  channelIds: string[];
  reason: string;
  status: CollectionRequestStatus;
  estimate: {
    channels: Array<{ channelId: string; mode: "backfill" | "incremental"; expectedUnits: number; worstCaseUnits: number }>;
    totalExpectedUnits: number;
    totalWorstCaseUnits: number;
    dailyBudgetUnits: number;
    unitsSpentToday: number;
    remainingTodayUnits: number;
    fitsToday: boolean;
  };
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: string;
  approvedAt: string | null;
  resolvedAt: string | null;
  resolvedReason: string | null;
  result: CollectionChannelResultView[] | null;
  unitsSpentTotal: number | null;
  error: string | null;
};

type Limits = {
  dailyBudgetUnits: number | null;
  unitsSpentToday: number;
  remainingTodayUnits: number | null;
  quotaDayResetsAt: string;
};

const STATUS_LABELS: Record<CollectionRequestStatus, UiTextKey> = {
  pending: "requests.collection.status.pending",
  approved: "requests.collection.status.approved",
  running: "requests.collection.status.running",
  done: "requests.collection.status.done",
  rejected: "requests.collection.status.rejected",
  failed: "requests.collection.status.failed",
};

// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md) -- the ONLY place one is approved or rejected. Approving runs the
// regular collection (24 h stale window, 24 h pause after a failure, daily budget) for the request's channels only and BLOCKS behind the shared
// progress pop-up until it returns (like "Send to YouTube"). It spends real YouTube Data API quota units, so the confirm dialog states the cost first.
/** `onChanged` runs after an approve or reject, so the summary line and badges follow at once (BL-140 review). */
export function MarketCollectionRequestsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const t = useT();
  const [requests, setRequests] = useState<CollectionRequest[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<CollectionRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CollectionRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const op = useOperation();
  const { runBlocking } = op;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, limitsRes] = await Promise.all([
        fetch("/api/market-intelligence/collection-requests"),
        fetch("/api/market-intelligence/collection-requests/limits"),
      ]);
      if (listRes.ok) setRequests(((await listRes.json()).requests ?? []) as CollectionRequest[]);
      if (limitsRes.ok) setLimits((await limitsRes.json()) as Limits);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function handleConfirmApprove() {
    const target = approveTarget;
    if (!target) return;
    setApproveTarget(null);
    setError(null);
    try {
      await runBlocking({
        title: t("requests.collection.runTitle"),
        stage: t("requests.collection.runStage"),
        request: async () => {
          const res = await fetch(`/api/market-intelligence/collection-requests/${encodeURIComponent(target.requestId)}/approve`, { method: "POST" });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) =>
          res.ok ? (data.status === "failed" ? runSummary(t, data) : null) : (data.message ?? data.error ?? t("common.errorStatus", { status: String(res.status) })),
        summarize: ({ data }) => runSummary(t, data),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("requests.collection.runFailed"));
    } finally {
      await fetchAll();
      onChanged?.();
    }
  }

  async function handleConfirmReject() {
    if (!rejectTarget) return;
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-intelligence/collection-requests/${encodeURIComponent(rejectTarget.requestId)}/reject`, {
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
      await fetchAll();
      onChanged?.();
    } finally {
      setRejecting(false);
    }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const active = requests.filter((r) => r.status === "approved" || r.status === "running");
  const resolved = requests.filter((r) => r.status !== "pending" && r.status !== "approved" && r.status !== "running");

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("requests.collection.title")}
          <InfoTooltip>{t("requests.collection.info")}</InfoTooltip>
        </h3>
        {limits && (
          <p className="mt-1 text-xs text-zinc-500">
            {limits.dailyBudgetUnits === null
              ? t("requests.collection.noBudget")
              : t("requests.collection.limits", {
                  budget: String(limits.dailyBudgetUnits),
                  spent: String(limits.unitsSpentToday),
                  left: String(limits.remainingTodayUnits ?? 0),
                  date: formatDisplayDateTime(limits.quotaDayResetsAt),
                })}
          </p>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && pending.length === 0 && active.length === 0 && <p className="text-sm text-zinc-500">{t("requests.collection.empty")}</p>}

      <div className="space-y-2">
        {pending.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
            <div className="mb-2">
              <FeatureErrorBoundary label={t("requests.channelAssignment")}>
                <MarketChannelAssignment recordKind="collection_request" recordId={request.requestId} />
              </FeatureErrorBoundary>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">
                  {t("requests.collection.channelCount", { count: request.channelIds.length })}
                </p>
                <p className="mt-1 text-xs text-zinc-400">{request.reason || t("requests.noReason")}</p>
                <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
                  {request.estimate.channels.map((c) => (
                    <li key={c.channelId} className="break-all">
                      {t("requests.collection.channelLine", {
                        channelId: c.channelId,
                        mode: t(c.mode === "backfill" ? "requests.collection.mode.backfill" : "requests.collection.mode.incremental"),
                        expected: c.expectedUnits,
                        worst: c.worstCaseUnits,
                      })}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-300">{estimateSentence(t, request.estimate)}</p>
                <p className={`mt-0.5 text-xs ${request.estimate.fitsToday ? "text-zinc-500" : "text-amber-400"}`}>{budgetSentence(t, request.estimate)}</p>
                <p className="mt-1 text-xs text-zinc-600">
                  {request.agentApiVersion
                    ? t("requests.createdViaVersion", { via: request.createdVia, version: request.agentApiVersion })
                    : t("requests.createdVia", { via: request.createdVia })}{" "}
                  &middot; {formatDisplayDateTime(request.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setApproveTarget(request)}
                  disabled={op.state.status === "running"}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
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
        {active.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-zinc-700 p-3 text-xs text-zinc-400">
            {t("requests.collection.activeLine", {
              status: t(STATUS_LABELS[request.status]),
              count: request.channelIds.length,
              date: request.approvedAt ? formatDisplayDateTime(request.approvedAt) : "",
            })}
          </div>
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <p className="text-xs font-medium text-zinc-500">{t("requests.history")}</p>
          {resolved.map((request) => (
            <div key={request.requestId} className="text-xs text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t("requests.collection.historyLine", { status: t(STATUS_LABELS[request.status]), count: request.channelIds.length })}
                  {request.unitsSpentTotal !== null ? ` · ${t("requests.collection.spent", { units: request.unitsSpentTotal })}` : ""}
                  {request.status === "rejected" && request.resolvedReason ? `: ${request.resolvedReason}` : ""}
                  {request.status === "failed" && request.error ? `: ${request.error}` : ""}
                </span>
                <span className="text-zinc-600">{request.resolvedAt ? formatDisplayDateTime(request.resolvedAt) : ""}</span>
              </div>
              {request.result && (
                <ul className="mt-1 space-y-0.5 pl-3 text-zinc-500">
                  {request.result.map((r) => (
                    <li key={r.channelId} className="break-all">
                      {r.channelId}: {t(OUTCOME_LABELS[r.outcome])}
                      {r.videosStored > 0 ? `, ${t("requests.collection.videosStored", { count: r.videosStored })}` : ""}
                      {r.unitsSpent > 0 ? `, ${unitsText(t, r.unitsSpent)}` : ""}
                      {r.newSnapshotsObservedAt ? `, ${t("requests.collection.observed", { date: formatDisplayDateTime(r.newSnapshotsObservedAt) })}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {approveTarget && (
        <ConfirmDialog
          title={t("requests.collection.approveTitle")}
          description={`${estimateSentence(t, approveTarget.estimate)} ${budgetSentence(t, approveTarget.estimate)} ${t("requests.collection.approveBody")}`}
          confirmLabel={t("requests.collection.approveAndRun")}
          confirmVariant="danger"
          onCancel={() => setApproveTarget(null)}
          onConfirm={() => void handleConfirmApprove()}
        />
      )}

      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <h4 className="text-base font-semibold text-zinc-100">{t("requests.collection.rejectTitle")}</h4>
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
                onClick={() => void handleConfirmReject()}
                disabled={rejecting || rejectReason.trim().length === 0}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rejecting ? t("requests.rejecting") : t("requests.reject")}
              </button>
            </div>
          </div>
        </div>
      )}

      <OperationOverlay state={op.state} onClose={op.reset} />
    </div>
  );
}
