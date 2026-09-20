"use client";

import { useCallback, useEffect, useState } from "react";

type OverviewRow = {
  videoId: string;
  title: string;
  defaultLanguage: string | null;
};

type GeneratedField = {
  field: "title" | "description";
  proposedValue: string;
  changeType: "add" | "modify" | "unchanged";
  validationStatus: "valid" | "invalid";
  validationError: string | null;
};

type GeneratedTarget = {
  videoId: string;
  language: string;
  providerError: string | null;
  fields: GeneratedField[];
};

type GenerationRowError = {
  videoId: string | null;
  language: string | null;
  message: string;
};

type EditorialContext = {
  targetAudience?: string;
  toneNotes?: string;
  terminologyNotes?: string;
  titleConstraints?: string;
  descriptionConstraints?: string;
};

type GenerationProvenance = {
  profileVersion: number | null;
  effectiveContext: EditorialContext | null;
};

type GenerationResponse = {
  results: GeneratedTarget[];
  errors: GenerationRowError[];
  summary: {
    targetsRequested: number;
    targetsGenerated: number;
    targetsFailed: number;
    validProposals: number;
    invalidProposals: number;
    unchangedProposals: number;
  };
  generationContext: GenerationProvenance;
};

/** Local, editable view of one generated (video, language) proposal, keyed for the
 * "inspect and edit" step. Never sent back to the AI provider -- only the final,
 * possibly-edited text is submitted when creating the Change Set. */
type EditableTarget = GeneratedTarget & {
  editedTitle: string;
  editedDescription: string;
  includeTitle: boolean;
  includeDescription: boolean;
};

function toEditable(target: GeneratedTarget): EditableTarget {
  const title = target.fields.find((f) => f.field === "title");
  const description = target.fields.find((f) => f.field === "description");
  return {
    ...target,
    editedTitle: title?.proposedValue ?? "",
    editedDescription: description?.proposedValue ?? "",
    includeTitle: Boolean(title && title.changeType !== "unchanged" && title.validationStatus === "valid"),
    includeDescription: Boolean(description && description.changeType !== "unchanged" && description.validationStatus === "valid"),
  };
}

export function AiLocalizationPanel() {
  const [channelId, setChannelId] = useState("");
  const [videos, setVideos] = useState<OverviewRow[]>([]);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [targetLanguages, setTargetLanguages] = useState("es");
  const [generating, setGenerating] = useState(false);
  const [targets, setTargets] = useState<EditableTarget[]>([]);
  const [rowErrors, setRowErrors] = useState<GenerationRowError[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdChangeSetId, setCreatedChangeSetId] = useState<string | null>(null);
  const [generationContext, setGenerationContext] = useState<GenerationProvenance | null>(null);

  const [connections, setConnections] = useState<Array<{ id: string; displayName: string; enabled: boolean; adapterType: string }>>([]);
  const [connectionId, setConnectionId] = useState<string>(""); // "" = default mock provider

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/ai-connections");
      if (!res.ok) return;
      const data = await res.json();
      setConnections((data.connections ?? []).filter((c: { enabled: boolean }) => c.enabled));
    })();
  }, []);

  const fetchChannels = useCallback(async () => {
    const res = await fetch("/api/channels");
    const data = await res.json();
    // Only one channel is ever active (docs/decisions/0004-active-channel-read-scoping.md) --
    // resolve it implicitly instead of keeping the full list around for a dropdown.
    if (!channelId && data.channels?.[0]) setChannelId(data.channels[0].channelId);
  }, [channelId]);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    if (!channelId) return;
    (async () => {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/localizations`);
      if (!res.ok) return;
      const data = await res.json();
      setVideos(data.videos ?? []);
    })();
  }, [channelId]);

  function toggleVideo(videoId: string) {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  async function handleGenerate() {
    setError(null);
    setCreatedChangeSetId(null);
    const languages = targetLanguages
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    if (selectedVideoIds.size === 0 || languages.length === 0) {
      setError("Select at least one video and one target language");
      return;
    }

    setGenerating(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/ai-localization/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoIds: [...selectedVideoIds],
          targetLanguages: languages,
          ...(connectionId ? { connectionId } : {}),
        }),
      });
      const data = (await res.json()) as GenerationResponse & { message?: string };
      if (!res.ok) {
        setError(data.message ?? "Generation failed");
        return;
      }
      setTargets(data.results.map(toEditable));
      setRowErrors(data.errors);
      setGenerationContext(data.generationContext);
    } finally {
      setGenerating(false);
    }
  }

  function updateTarget(index: number, patch: Partial<EditableTarget>) {
    setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  async function handleCreateChangeSet() {
    setError(null);
    const proposals = targets
      .filter((t) => t.includeTitle || t.includeDescription)
      .map((t) => ({
        videoId: t.videoId,
        language: t.language,
        ...(t.includeTitle ? { title: t.editedTitle } : {}),
        ...(t.includeDescription ? { description: t.editedDescription } : {}),
      }));

    if (proposals.length === 0) {
      setError("No proposals selected to include");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/ai-localization/change-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposals,
          // Echoes back exactly what this generation actually used, so it can be
          // recorded as immutable provenance against the Change Set -- frozen at this
          // moment, unaffected by any later edit to the profile (AC-PROFILE-08).
          ...(generationContext ? { provenance: generationContext } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to create change set");
        return;
      }
      setCreatedChangeSetId(data.changeSet.id);
      setTargets([]);
      setGenerationContext(null);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={targetLanguages}
          onChange={(e) => setTargetLanguages(e.target.value)}
          placeholder="Target languages, comma-separated (e.g. es, de, pt-BR)"
          className="min-w-[280px] rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
        />
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
          title="Configure connections in the Settings tab"
        >
          <option value="">Mock provider (default, no network)</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? "Generating..." : "Generate proposals"}
        </button>
      </div>
      {connectionId && (
        <p className="text-xs text-amber-400">
          A real connection is selected &mdash; generating will make a real request to its
          configured endpoint and may incur cost.
        </p>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800">
        {videos.map((v) => (
          <label
            key={v.videoId}
            className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 text-sm text-zinc-300 last:border-b-0 hover:bg-zinc-900"
          >
            <input type="checkbox" checked={selectedVideoIds.has(v.videoId)} onChange={() => toggleVideo(v.videoId)} />
            <span className="flex-1 truncate">{v.title}</span>
            <span className="text-xs text-zinc-500">{v.defaultLanguage ?? "?"}</span>
          </label>
        ))}
        {videos.length === 0 && <p className="p-3 text-sm text-zinc-500">No synchronized videos for this channel.</p>}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {rowErrors.length > 0 && (
        <div className="rounded-md border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
          {rowErrors.map((e, i) => (
            <p key={i}>
              {e.videoId ?? "?"} / {e.language ?? "?"}: {e.message}
            </p>
          ))}
        </div>
      )}

      {targets.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200">Review &amp; edit proposals</h3>
          {targets.map((t, i) => (
            <div key={`${t.videoId}-${t.language}`} className="rounded-lg border border-zinc-800 p-4">
              <p className="mb-2 text-xs text-zinc-500">
                {t.videoId} &rarr; {t.language}
              </p>
              {t.providerError ? (
                <p className="text-sm text-red-400">Provider error: {t.providerError}</p>
              ) : (
                <div className="space-y-3">
                  <label className="block">
                    <span className="flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={t.includeTitle}
                        onChange={(e) => updateTarget(i, { includeTitle: e.target.checked })}
                      />
                      Title
                    </span>
                    <textarea
                      value={t.editedTitle}
                      onChange={(e) => updateTarget(i, { editedTitle: e.target.value })}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                      rows={2}
                    />
                  </label>
                  <label className="block">
                    <span className="flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={t.includeDescription}
                        onChange={(e) => updateTarget(i, { includeDescription: e.target.checked })}
                      />
                      Description
                    </span>
                    <textarea
                      value={t.editedDescription}
                      onChange={(e) => updateTarget(i, { editedDescription: e.target.value })}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                      rows={3}
                    />
                  </label>
                </div>
              )}
            </div>
          ))}

          <button
            onClick={handleCreateChangeSet}
            disabled={creating}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create Change Set from reviewed proposals"}
          </button>
        </div>
      )}

      {createdChangeSetId && (
        <p className="rounded-md border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">
          Change Set <code>{createdChangeSetId}</code> created. Approve or reject its changes in the
          &ldquo;Localizations&rdquo; tab, then select approved changes into a Batch in the &ldquo;Batches&rdquo; tab for a
          dry-run preview. No metadata is written to YouTube from this tab, or from either of those.
        </p>
      )}
    </div>
  );
}
