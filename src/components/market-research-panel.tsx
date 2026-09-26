"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
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

// Phase 9 slice 2 (docs/roadmap/plans/PHASE_9_PLAN.md) -- global (not channel-scoped) market
// research watchlist. Manually-seeded only in this slice: adding a channel and recording evidence
// are both operator-entered here; no automatic discovery or public-snapshot fetch exists yet
// (slice 3).
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

  const [newObservation, setNewObservation] = useState("");
  const [newSource, setNewSource] = useState("");
  const [newConfidence, setNewConfidence] = useState("");
  const [recordingEvidence, setRecordingEvidence] = useState(false);
  const [fetchingSnapshot, setFetchingSnapshot] = useState(false);

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

  function handleSelectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    void fetchEvidence(channelId);
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
            <button
              onClick={() => handleSelectChannel(c.channelId)}
              className="w-full text-left"
            >
              <p className="text-sm font-medium text-zinc-200">
                {c.handleOrUrl ?? c.channelId} <span className="text-xs text-zinc-500">({c.channelId})</span>
              </p>
              <p className="text-xs text-zinc-400">{c.reason}</p>
              <p className="text-xs text-zinc-500">Added {formatDisplayDateTime(c.addedAt)}</p>
            </button>

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
    </div>
  );
}
