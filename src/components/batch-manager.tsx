"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

type SyncedChannel = {
  channelId: string;
  title: string;
};

type ChangeSetSummary = {
  id: string;
  channelId: string;
  status: "in_review" | "approved" | "partially_approved" | "rejected";
  importedFilename: string | null;
  totalChanges: number;
  approvedCount: number;
  createdAt: string;
};

type Change = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  proposedValue: string;
  validationStatus: "valid" | "invalid";
  conflictStatus: "none" | "conflict";
  approvalStatus: "pending" | "approved" | "rejected";
};

type Batch = {
  id: string;
  channelId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED";
  concurrency: number;
  dryRun: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type LedgerRow = {
  id: string;
  batchId: string;
  videoId: string;
  changeIds: string[];
  status: string;
  error: string | null;
};

type AuditEvent = {
  id: number;
  ledgerRowId: string;
  videoId: string;
  eventType: string;
  occurredAt: string;
};

type ApiError = { error: string; message: string };

/**
 * Phase 5 Web UI (DEC-OQ-5, minimum scope per the approved acceptance contract):
 * select approved changes -> create a Batch -> inspect its immutable membership -> run
 * its dry-run preview -> inspect the resulting diff/status/errors/audit trail.
 *
 * "Create as a real batch" and the "Execute" action below are only rendered/enabled when
 * the Settings-tab "live writes" toggle is on (owner instruction, 2026-09-21,
 * docs/TECHNICAL_DEBT.md RISK-09) -- with it off (the default every session), a batch
 * created here is still forced dry-run by the API route regardless of what this UI sends
 * (see src/app/api/channels/[channelId]/batches/route.ts), and Execute is hidden
 * entirely, exactly as before this change.
 */
export function BatchManager() {
  const [channels, setChannels] = useState<SyncedChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [changeSets, setChangeSets] = useState<ChangeSetSummary[]>([]);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<string>>(new Set());
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [createAsLive, setCreateAsLive] = useState(false);
  const [liveWritesEnabled, setLiveWritesEnabled] = useState(false);

  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [batchErrors, setBatchErrors] = useState<Array<{ videoId: string; status: string; error: string | null }>>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmingExecute, setConfirmingExecute] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setLiveWritesEnabled(Boolean(data.liveWritesEnabled));
    })();
  }, []);

  const fetchChannels = useCallback(async () => {
    const res = await fetch("/api/channels");
    const data = await res.json();
    setChannels(data.channels ?? []);
    if (!channelId && data.channels?.[0]) setChannelId(data.channels[0].channelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChangeSets = useCallback(async (id: string) => {
    const res = await fetch(`/api/channels/${encodeURIComponent(id)}/change-sets`);
    const data = await res.json();
    setChangeSets(data.changeSets ?? []);
  }, []);

  const fetchBatches = useCallback(async (id: string) => {
    const res = await fetch(`/api/channels/${encodeURIComponent(id)}/batches`);
    const data = await res.json();
    setBatches(data.batches ?? []);
  }, []);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    if (!channelId) return;
    void fetchChangeSets(channelId);
    void fetchBatches(channelId);
    setSelectedChangeSetId(null);
    setChanges([]);
    setSelectedChangeIds(new Set());
    setSelectedBatchId(null);
  }, [channelId, fetchChangeSets, fetchBatches]);

  async function openChangeSet(changeSetId: string) {
    setSelectedChangeSetId(changeSetId);
    setSelectedChangeIds(new Set());
    const res = await fetch(
      `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}?status=approved&pageSize=500`
    );
    const data = await res.json();
    setChanges(data.changes ?? []);
  }

  function toggleChange(id: string) {
    setSelectedChangeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createBatch() {
    if (selectedChangeIds.size === 0) return;
    setCreatingBatch(true);
    setError(null);
    try {
      // Group the operator's selected, already-approved changes by video -- DEC-OQ-1:
      // one ledger row per video, all of that video's selected changes bundled together.
      const byVideo = new Map<string, string[]>();
      for (const change of changes) {
        if (!selectedChangeIds.has(change.id)) continue;
        const list = byVideo.get(change.videoId) ?? [];
        list.push(change.id);
        byVideo.set(change.videoId, list);
      }
      const selections = [...byVideo.entries()].map(([videoId, changeIds]) => ({ videoId, changeIds }));

      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections, dryRun: liveWritesEnabled ? !createAsLive : true }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data as ApiError;
        throw new Error(err.message ?? "Failed to create batch");
      }
      setSelectedChangeIds(new Set());
      setCreateAsLive(false);
      await fetchBatches(channelId);
      setSelectedBatchId(data.id);
      await openBatch(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create batch");
    } finally {
      setCreatingBatch(false);
    }
  }

  async function executeBatch(batchId: string) {
    setExecuting(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data as ApiError;
        throw new Error(err.message ?? "Failed to execute batch");
      }
      await openBatch(batchId);
      await fetchBatches(channelId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to execute batch");
    } finally {
      setExecuting(false);
    }
  }

  async function openBatch(batchId: string) {
    setSelectedBatchId(batchId);
    setError(null);
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}`);
    const data = await res.json();
    setLedgerRows(data.ledgerRows ?? []);

    const [errorsRes, auditRes] = await Promise.all([
      fetch(`/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}/errors`),
      fetch(`/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}/audit`),
    ]);
    const errorsData = await errorsRes.json();
    const auditData = await auditRes.json();
    setBatchErrors(errorsData.errors ?? []);
    setAuditEvents(auditData.events ?? []);
  }

  async function runDryRun(batchId: string) {
    setPreparing(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}/prepare`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data as ApiError;
        throw new Error(err.message ?? "Failed to run dry-run preview");
      }
      await openBatch(batchId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run dry-run preview");
    } finally {
      setPreparing(false);
    }
  }

  const approvedSelectableChanges = changes.filter(
    (c) => c.approvalStatus === "approved" && c.validationStatus === "valid" && c.conflictStatus === "none"
  );

  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;
  const selectedChannelTitle = channels.find((c) => c.channelId === channelId)?.title ?? channelId;
  const totalFieldCount = ledgerRows.reduce((sum, row) => sum + row.changeIds.length, 0);

  return (
    <div className="space-y-8">
      {liveWritesEnabled ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          &ldquo;Live writes&rdquo; is ON (Settings) &mdash; a batch created below with &ldquo;Create as a real,
          live batch&rdquo; checked can perform a genuine, non-dry-run write to YouTube once you click
          Execute. Turn it back off in Settings if you don&rsquo;t intend to do that right now.
        </div>
      ) : (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          Real YouTube writes are currently disabled by a server-side safety barrier
          (&ldquo;Live writes&rdquo; is off in Settings). Every batch created here always runs in dry-run
          mode only &mdash; nothing is ever written to YouTube from this tab.
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs text-zinc-500">Channel</label>
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.title}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-300">1. Pick a Change Set with approved changes</h3>
        <div className="flex flex-wrap gap-2">
          {changeSets.map((cs) => (
            <button
              key={cs.id}
              onClick={() => openChangeSet(cs.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                selectedChangeSetId === cs.id ? "border-zinc-400 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {cs.importedFilename ?? cs.id.slice(0, 8)} &mdash; {cs.approvedCount} approved
            </button>
          ))}
          {changeSets.length === 0 && <p className="text-sm text-zinc-500">No Change Sets for this channel yet.</p>}
        </div>
      </div>

      {selectedChangeSetId && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-300">
            2. Select approved changes for a new Batch ({selectedChangeIds.size} selected)
          </h3>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 p-2">
            {approvedSelectableChanges.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-900">
                <input type="checkbox" checked={selectedChangeIds.has(c.id)} onChange={() => toggleChange(c.id)} />
                <span className="font-mono text-xs text-zinc-500">{c.videoId}</span>
                <span className="text-zinc-500">/{c.language}/{c.field}:</span>
                <span className="truncate text-zinc-200">{c.proposedValue}</span>
              </label>
            ))}
            {approvedSelectableChanges.length === 0 && (
              <p className="p-2 text-sm text-zinc-500">No approved, valid, non-conflicting changes in this Change Set.</p>
            )}
          </div>
          {liveWritesEnabled && (
            <label className="mt-3 flex items-center gap-2 text-xs text-amber-300">
              <input type="checkbox" checked={createAsLive} onChange={(e) => setCreateAsLive(e.target.checked)} />
              Create as a real, live batch (will be able to write to YouTube)
            </label>
          )}
          <button
            onClick={createBatch}
            disabled={selectedChangeIds.size === 0 || creatingBatch}
            className="mt-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40"
          >
            {creatingBatch ? "Creating..." : createAsLive ? "Create Batch (live)" : "Create Batch (dry-run)"}
          </button>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-300">3. Batches for this channel</h3>
        <div className="space-y-1">
          {batches.map((b) => (
            <button
              key={b.id}
              onClick={() => openBatch(b.id)}
              className={`block w-full rounded-lg border px-3 py-2 text-left text-xs ${
                selectedBatchId === b.id ? "border-zinc-400 bg-zinc-800" : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              <span className="font-mono text-zinc-400">{b.id.slice(0, 8)}</span>{" "}
              <span className="text-zinc-500">
                &mdash; {b.status}, {b.dryRun ? "dry-run" : "live"}, created {new Date(b.createdAt).toLocaleString()}
              </span>
            </button>
          ))}
          {batches.length === 0 && <p className="text-sm text-zinc-500">No batches yet.</p>}
        </div>
      </div>

      {selectedBatchId && (
        <div className="space-y-4 rounded-lg border border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-300">
              Batch {selectedBatchId.slice(0, 8)} &mdash; immutable membership ({ledgerRows.length} video{ledgerRows.length === 1 ? "" : "s"})
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => runDryRun(selectedBatchId)}
                disabled={preparing}
                className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-400 disabled:opacity-40"
              >
                {preparing ? "Running dry-run..." : "Run dry-run preview"}
              </button>
              {liveWritesEnabled && selectedBatch && !selectedBatch.dryRun && selectedBatch.status === "PENDING" && (
                <button
                  onClick={() => setConfirmingExecute(true)}
                  disabled={executing}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                >
                  {executing ? "Executing..." : "Execute (real write)"}
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="p-1 text-left">Video</th>
                <th className="p-1 text-left">Changes</th>
                <th className="p-1 text-left">Status</th>
                <th className="p-1 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((row) => (
                <tr key={row.id} className="border-t border-zinc-900">
                  <td className="p-1 font-mono">{row.videoId}</td>
                  <td className="p-1 text-zinc-500">{row.changeIds.length}</td>
                  <td className="p-1">{row.status}</td>
                  <td className="p-1 text-red-400">{row.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold text-zinc-400">Error report</h4>
            {batchErrors.length === 0 ? (
              <p className="text-xs text-zinc-500">No errors.</p>
            ) : (
              <ul className="space-y-0.5 text-xs text-red-400">
                {batchErrors.map((e, i) => (
                  <li key={i}>
                    {e.videoId}: {e.status} &mdash; {e.error}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold text-zinc-400">Audit trail</h4>
            {auditEvents.length === 0 ? (
              <p className="text-xs text-zinc-500">No audit events yet &mdash; run the dry-run preview above.</p>
            ) : (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-zinc-500">
                {auditEvents.map((e) => (
                  <li key={e.id}>
                    {new Date(e.occurredAt).toLocaleTimeString()} &mdash; {e.videoId} &mdash; {e.eventType}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {confirmingExecute && selectedBatchId && (
        <ConfirmDialog
          title="Send this batch to YouTube for real?"
          description={
            `Channel: ${selectedChannelTitle}. ${ledgerRows.length} video${ledgerRows.length === 1 ? "" : "s"}, ` +
            `${totalFieldCount} field${totalFieldCount === 1 ? "" : "s"} total. This is a real, non-dry-run write -- ` +
            `each video still goes through identity check, a fresh conflict check, and an automatic backup before ` +
            `being written, and the result will show here per video. This cannot be undone by this app.`
          }
          confirmLabel="Execute"
          confirmVariant="danger"
          onCancel={() => setConfirmingExecute(false)}
          onConfirm={() => {
            setConfirmingExecute(false);
            executeBatch(selectedBatchId);
          }}
        />
      )}
    </div>
  );
}
