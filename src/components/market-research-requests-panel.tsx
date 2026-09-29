"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

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

const STATUS_LABELS: Record<MarketResearchRequestStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  execution_failed: "Execution failed",
};

// Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §9) -- the ONLY
// place a research request can be approved or rejected. Approving spends real quota (~100 units,
// one search.list call) -- the approve action sits behind ConfirmDialog (never window.confirm, per
// this app's own standing UI convention) and states the cost explicitly before the operator
// commits.
export function MarketResearchRequestsPanel() {
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
        setError(data.message ?? "Failed to approve request");
        return;
      }
      setApproveTarget(null);
      await fetchRequests();
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
        setError(data.message ?? "Failed to reject request");
        return;
      }
      setRejectTarget(null);
      setRejectReason("");
      await fetchRequests();
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
          Research requests
          <InfoTooltip>
            Structured research drafts an agent (MCP/CLI) can create -- an agent can never approve
            or reject its own request. Approving here spends real YouTube API quota (~100 units,
            one search.list call) and runs Discover with the request&rsquo;s own query.
          </InfoTooltip>
        </h3>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && pending.length === 0 && <p className="text-sm text-zinc-500">No pending requests.</p>}

      <div className="space-y-2">
        {pending.map((request) => (
          <div key={request.requestId} className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-zinc-100">{request.query}</p>
                <p className="mt-1 text-xs text-zinc-400">{request.rationale}</p>
                {request.monitorDurationDays !== null && (
                  <p className="mt-1 text-xs text-zinc-500">Requested monitoring: {request.monitorDurationDays} days (metadata only)</p>
                )}
                <p className="mt-1 text-xs text-zinc-600">
                  Created via {request.createdVia}
                  {request.agentApiVersion ? ` (agent API v${request.agentApiVersion})` : ""} &middot;{" "}
                  {formatDisplayDateTime(request.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setApproveTarget(request)}
                  className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
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
      </div>

      {resolved.length > 0 && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-xs font-medium text-zinc-500">History</p>
          {resolved.map((request) => (
            <div key={request.requestId} className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
              <span>
                {request.query} &middot; {STATUS_LABELS[request.status]}
                {request.status === "executed" && ` (${request.candidatesFound ?? 0} found, ${request.candidatesNew ?? 0} new)`}
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
          title="Approve this research request?"
          description={`This spends real YouTube API quota (~100 units, one search.list call) for "${approveTarget.query}". This cannot be undone.`}
          confirmLabel={approving ? "Approving..." : "Approve"}
          confirmVariant="danger"
          onCancel={() => setApproveTarget(null)}
          onConfirm={handleConfirmApprove}
        />
      )}

      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <h4 className="text-base font-semibold text-zinc-100">Reject this research request?</h4>
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
                onClick={handleConfirmReject}
                disabled={rejecting || rejectReason.trim().length === 0}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {rejecting ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
