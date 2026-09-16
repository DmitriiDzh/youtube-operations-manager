"use client";

import { useCallback, useEffect, useState } from "react";

type Change = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: "add" | "modify" | "unchanged";
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
  approvalStatus: "pending" | "approved" | "rejected";
};

type ChangeSet = {
  id: string;
  channelId: string;
  status: "in_review" | "approved" | "partially_approved" | "rejected";
  importedFilename: string | null;
  totalChanges: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  conflictCount: number;
  invalidCount: number;
  createdAt: string;
};

type StatusFilter = "all" | "pending" | "approved" | "rejected" | "conflict" | "invalid";

function fieldLabel(field: Change["field"]) {
  return field === "title" ? "Title" : "Description";
}

function changeTypeBadge(type: Change["changeType"]) {
  const styles: Record<Change["changeType"], string> = {
    add: "bg-green-900/40 text-green-400",
    modify: "bg-blue-900/40 text-blue-400",
    unchanged: "bg-zinc-800 text-zinc-500",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${styles[type]}`}>{type}</span>;
}

export function ChangeSetReview({ channelId, changeSetId, onClose }: { channelId: string; changeSetId: string; onClose: () => void }) {
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [languageFilter, setLanguageFilter] = useState("");
  const [videoFilter, setVideoFilter] = useState("");
  const [busyChangeId, setBusyChangeId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (languageFilter.trim()) params.set("language", languageFilter.trim());
      if (videoFilter.trim()) params.set("videoId", videoFilter.trim());
      params.set("pageSize", "100");

      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}?${params.toString()}`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setChangeSet(data.changeSet);
      setChanges(data.changes);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [channelId, changeSetId, statusFilter, languageFilter, videoFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(changeId: string, action: "approve" | "reject") {
    setBusyChangeId(changeId);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}/changes/${encodeURIComponent(changeId)}/${action}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyChangeId(null);
    }
  }

  async function handleBulk(action: "approve-all" | "reject-all") {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}/${action}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Change Set Review</h3>
          {changeSet && (
            <p className="text-xs text-zinc-500">
              {changeSet.importedFilename ?? "XLSX import"} · {changeSet.totalChanges} changes · status:{" "}
              <span className="font-medium text-zinc-300">{changeSet.status}</span>
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          Close
        </button>
      </div>

      {changeSet && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">Total {changeSet.totalChanges}</span>
          <span className="rounded bg-amber-900/40 px-2 py-1 text-amber-400">Pending {changeSet.pendingCount}</span>
          <span className="rounded bg-green-900/40 px-2 py-1 text-green-400">Approved {changeSet.approvedCount}</span>
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">Rejected {changeSet.rejectedCount}</span>
          <span className="rounded bg-red-900/40 px-2 py-1 text-red-400">Conflicts {changeSet.conflictCount}</span>
          <span className="rounded bg-red-900/40 px-2 py-1 text-red-400">Invalid {changeSet.invalidCount}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs"
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="conflict">Conflicts</option>
          <option value="invalid">Invalid</option>
        </select>
        <input
          value={languageFilter}
          onChange={(e) => setLanguageFilter(e.target.value)}
          placeholder="Language (e.g. es)"
          className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs placeholder:text-zinc-600"
        />
        <input
          value={videoFilter}
          onChange={(e) => setVideoFilter(e.target.value)}
          placeholder="Video ID"
          className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs placeholder:text-zinc-600"
        />
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => handleBulk("approve-all")}
            disabled={bulkBusy}
            className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            Approve all valid
          </button>
          <button
            onClick={() => handleBulk("reject-all")}
            disabled={bulkBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Reject all pending
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}

      <div className="space-y-2">
        {loading && <p className="text-sm text-zinc-500">Loading...</p>}
        {!loading && changes.length === 0 && <p className="text-sm text-zinc-500">No changes match the current filters.</p>}
        {changes.map((change) => (
          <div key={change.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="font-medium text-zinc-300">{change.videoId}</span>
              <span>·</span>
              <span>{change.language}</span>
              <span>·</span>
              <span>{fieldLabel(change.field)}</span>
              {changeTypeBadge(change.changeType)}
              {change.conflictStatus === "conflict" && (
                <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] uppercase text-red-400">Conflict</span>
              )}
              {change.validationStatus === "invalid" && (
                <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] uppercase text-red-400">Invalid</span>
              )}
              <span
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase ${
                  change.approvalStatus === "approved"
                    ? "bg-green-900/40 text-green-400"
                    : change.approvalStatus === "rejected"
                      ? "bg-zinc-800 text-zinc-500"
                      : "bg-amber-900/40 text-amber-400"
                }`}
              >
                {change.approvalStatus}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <p className="text-[10px] uppercase text-zinc-600">Current (synced)</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-400">{change.baselineValue || "(empty)"}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-zinc-600">Proposed</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-100">{change.proposedValue}</p>
              </div>
            </div>

            {change.validationError && <p className="mt-2 text-xs text-red-400">{change.validationError}</p>}
            {change.conflictStatus === "conflict" && (
              <p className="mt-2 text-xs text-red-400">
                The remote value changed on YouTube since this row was exported. Re-sync and re-import to resolve.
              </p>
            )}

            {change.approvalStatus === "pending" && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleAction(change.id, "approve")}
                  disabled={busyChangeId === change.id || change.validationStatus === "invalid" || change.conflictStatus === "conflict"}
                  className="rounded-lg bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleAction(change.id, "reject")}
                  disabled={busyChangeId === change.id}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
