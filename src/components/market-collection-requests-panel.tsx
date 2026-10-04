"use client";

import { useCallback, useEffect, useState } from "react";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment } from "./market-channel-assignment";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { OperationOverlay, useOperation } from "./operation-progress";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
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

const STATUS_LABELS: Record<CollectionRequestStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  running: "Running",
  done: "Done",
  rejected: "Rejected",
  failed: "Failed",
};

// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md) -- the ONLY place one is approved or rejected. Approving runs the
// regular collection (24 h stale window, 24 h pause after a failure, daily budget) for the request's channels only and BLOCKS behind the shared
// progress pop-up until it returns (like "Send to YouTube"). It spends real YouTube Data API quota units, so the confirm dialog states the cost first.
export function MarketCollectionRequestsPanel() {
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
        title: "Collecting competitor channels",
        stage: "Collecting the requested channels from YouTube",
        request: async () => {
          const res = await fetch(`/api/market-intelligence/collection-requests/${encodeURIComponent(target.requestId)}/approve`, { method: "POST" });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) => (res.ok ? (data.status === "failed" ? runSummary(data) : null) : (data.message ?? data.error ?? `Error ${res.status}`)),
        summarize: ({ data }) => runSummary(data),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run the collection request");
    } finally {
      await fetchAll();
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
        setError(data.message ?? "Failed to reject request");
        return;
      }
      setRejectTarget(null);
      setRejectReason("");
      await fetchAll();
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
          Collection requests
          <InfoTooltip>
            An agent (MCP/CLI) can ask for watchlist channels to be collected, with a cost estimate -- it can never approve or run its own request.
            Approving here runs the regular collection for exactly those channels (still skipping channels collected or failed within 24 h) and
            spends YouTube Data API quota units from your daily budget, not model tokens.
          </InfoTooltip>
        </h3>
        {limits && (
          <p className="mt-1 text-xs text-zinc-500">
            {limits.dailyBudgetUnits === null
              ? "No daily unit budget is set (Settings), so requests cannot be created or run."
              : `Daily budget ${limits.dailyBudgetUnits}, spent today ${limits.unitsSpentToday}, left ${limits.remainingTodayUnits ?? 0}. Resets ${formatDisplayDateTime(limits.quotaDayResetsAt)}.`}
          </p>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && pending.length === 0 && active.length === 0 && <p className="text-sm text-zinc-500">No pending collection requests.</p>}

      <div className="space-y-2">
        {pending.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
            <div className="mb-2">
              <FeatureErrorBoundary label="Channel assignment">
                <MarketChannelAssignment recordKind="collection_request" recordId={request.requestId} />
              </FeatureErrorBoundary>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">
                  {request.channelIds.length} channel{request.channelIds.length === 1 ? "" : "s"}
                </p>
                <p className="mt-1 text-xs text-zinc-400">{request.reason || "No reason given."}</p>
                <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
                  {request.estimate.channels.map((c) => (
                    <li key={c.channelId} className="break-all">
                      {c.channelId} &middot; {c.mode === "backfill" ? "deep collection" : "refresh"} &middot; about {unitsText(c.expectedUnits)}, at most{" "}
                      {unitsText(c.worstCaseUnits)}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-300">{estimateSentence(request.estimate)}</p>
                <p className={`mt-0.5 text-xs ${request.estimate.fitsToday ? "text-zinc-500" : "text-amber-400"}`}>{budgetSentence(request.estimate)}</p>
                <p className="mt-1 text-xs text-zinc-600">
                  Created via {request.createdVia}
                  {request.agentApiVersion ? ` (agent API v${request.agentApiVersion})` : ""} &middot; {formatDisplayDateTime(request.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setApproveTarget(request)}
                  disabled={op.state.status === "running"}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => setRejectTarget(request)}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-red-700 hover:text-red-400"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
        {active.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-zinc-700 p-3 text-xs text-zinc-400">
            {STATUS_LABELS[request.status]} &middot; {request.channelIds.length} channel{request.channelIds.length === 1 ? "" : "s"} &middot; started{" "}
            {request.approvedAt ? formatDisplayDateTime(request.approvedAt) : ""}
          </div>
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <p className="text-xs font-medium text-zinc-500">History</p>
          {resolved.map((request) => (
            <div key={request.requestId} className="text-xs text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {STATUS_LABELS[request.status]} &middot; {request.channelIds.length} channel{request.channelIds.length === 1 ? "" : "s"}
                  {request.unitsSpentTotal !== null ? ` · ${unitsText(request.unitsSpentTotal)} spent` : ""}
                  {request.status === "rejected" && request.resolvedReason ? `: ${request.resolvedReason}` : ""}
                  {request.status === "failed" && request.error ? `: ${request.error}` : ""}
                </span>
                <span className="text-zinc-600">{request.resolvedAt ? formatDisplayDateTime(request.resolvedAt) : ""}</span>
              </div>
              {request.result && (
                <ul className="mt-1 space-y-0.5 pl-3 text-zinc-500">
                  {request.result.map((r) => (
                    <li key={r.channelId} className="break-all">
                      {r.channelId}: {OUTCOME_LABELS[r.outcome]}
                      {r.videosStored > 0 ? `, ${r.videosStored} video${r.videosStored === 1 ? "" : "s"} stored` : ""}
                      {r.unitsSpent > 0 ? `, ${unitsText(r.unitsSpent)}` : ""}
                      {r.newSnapshotsObservedAt ? `, observed ${formatDisplayDateTime(r.newSnapshotsObservedAt)}` : ""}
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
          title="Approve and run this collection request?"
          description={`${estimateSentence(approveTarget.estimate)} ${budgetSentence(approveTarget.estimate)} The collection runs now and you will wait for it to finish; channels collected or failed within 24 h are skipped.`}
          confirmLabel="Approve and run"
          confirmVariant="danger"
          onCancel={() => setApproveTarget(null)}
          onConfirm={() => void handleConfirmApprove()}
        />
      )}

      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <h4 className="text-base font-semibold text-zinc-100">Reject this collection request?</h4>
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejecting"
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
                Cancel
              </button>
              <button
                onClick={() => void handleConfirmReject()}
                disabled={rejecting || rejectReason.trim().length === 0}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rejecting ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      <OperationOverlay state={op.state} onClose={op.reset} />
    </div>
  );
}
