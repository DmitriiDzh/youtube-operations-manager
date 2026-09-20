"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangeSetReview } from "./change-set-review";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OverviewRow = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  defaultLanguage: string | null;
  presentLanguages: string[];
  missingLanguages: string[];
  status: "complete" | "missing";
  lastSyncedAt: string;
};

type Overview = {
  channelId: string;
  channelTitle: string;
  languages: string[];
  totalVideos: number;
  videos: OverviewRow[];
};

type DetailLocale = {
  language: string;
  remoteTitle: string;
  remoteDescription: string;
};

type Detail = {
  videoId: string;
  originalTitle: string;
  originalDescription: string;
  defaultLanguage: string | null;
  locales: DetailLocale[];
  lastSyncedAt: string;
};

type ImportSummary = {
  videosFound: number;
  localizationRows: number;
  validChanges: number;
  unchangedValues: number;
  invalidRows: number;
  conflicts: number;
};

type ImportRowError = {
  row: number;
  videoId: string | null;
  language: string | null;
  message: string;
};

type ChangeSetSummary = {
  id: string;
  status: "in_review" | "approved" | "partially_approved" | "rejected";
  source: "xlsx_import" | "ai_localization" | "deletion";
  importedFilename: string | null;
  totalChanges: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  conflictCount: number;
  invalidCount: number;
  createdAt: string;
};

type SubTab = "all" | "in_progress" | "approved";

const SUB_TABS: Array<{ value: SubTab; label: string }> = [
  { value: "all", label: "Все" },
  { value: "in_progress", label: "В процессе" },
  { value: "approved", label: "Одобрено" },
];

function matchesSubTab(cs: ChangeSetSummary, subTab: SubTab): boolean {
  if (subTab === "all") return true;
  if (subTab === "in_progress") return cs.status === "in_review" || cs.status === "partially_approved";
  return cs.status === "approved";
}

// --- AI generation types (moved from the former "AI Localization" tab) ---

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
  generationContext: GenerationProvenance;
};

/** Local, editable view of one generated (video, language) proposal -- never sent back to the
 * AI provider, only the final, possibly-edited text is submitted when creating the Change Set. */
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
    includeDescription: Boolean(
      description && description.changeType !== "unchanged" && description.validationStatus === "valid"
    ),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The "Languages" tab (docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md) -- formerly two separate
 * tabs, "Localizations" and "AI Localization". AI generation is now the primary path to add a
 * language (owner, Telegram msg 128: "локализация с помощью агента... ручная правка... только
 * для того чтобы проверить что сделал агент"); manual XLSX import remains available as a
 * secondary, channel-level bulk action. Sub-tabs ("Все/В процессе/Одобрено") mirror Studio's own
 * Languages page but are mapped onto this app's real unit of work -- a Change Set's approval
 * status, not a per-video "draft/published" state Studio's literal UI assumes and this app's
 * batch/approval workflow doesn't have. "Одобрено" never means "Опубликовано" -- Phase 5 live
 * YouTube writes remain barrier-disabled (docs/TECHNICAL_DEBT.md RISK-09).
 *
 * Deliberate restyle from the former "Localizations" table (L2): the per-language ✓/— grid is
 * replaced with a single language count column, matching Studio's own Languages list (which
 * shows a count, not a full grid, in the main table) -- the full per-language breakdown is still
 * available in the expanded per-video detail row, so no information is lost, only demoted to a
 * drill-down.
 */
export function LanguagesManager() {
  const [channelId, setChannelId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [changeSets, setChangeSets] = useState<ChangeSetSummary[]>([]);
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [openChangeSetId, setOpenChangeSetId] = useState<string | null>(null);

  // --- AI generation (primary path) ---
  const generateSectionRef = useRef<HTMLDivElement | null>(null);
  const [generateOpen, setGenerateOpen] = useState(true);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [targetLanguages, setTargetLanguages] = useState("es");
  const [generating, setGenerating] = useState(false);
  const [targets, setTargets] = useState<EditableTarget[]>([]);
  const [rowErrors, setRowErrors] = useState<GenerationRowError[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdChangeSetId, setCreatedChangeSetId] = useState<string | null>(null);
  const [generationContext, setGenerationContext] = useState<GenerationProvenance | null>(null);
  const [connections, setConnections] = useState<
    Array<{ id: string; displayName: string; enabled: boolean; adapterType: string }>
  >([]);
  const [connectionId, setConnectionId] = useState<string>("");

  // --- XLSX import/export (secondary, bulk path) ---
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewSummary, setPreviewSummary] = useState<ImportSummary | null>(null);
  const [previewErrors, setPreviewErrors] = useState<ImportRowError[]>([]);
  const [previewTotalErrors, setPreviewTotalErrors] = useState(0);
  const [exportSelectedIds, setExportSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [creatingChangeSet, setCreatingChangeSet] = useState(false);

  const fetchOverview = useCallback(async (id: string) => {
    if (!id) {
      setOverview(null);
      return;
    }
    setLoadingOverview(true);
    setError(null);
    setExpandedVideoId(null);
    setDetail(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(id)}/localizations`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setOverview(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const fetchChangeSets = useCallback(async (id: string) => {
    if (!id) {
      setChangeSets([]);
      return;
    }
    const res = await fetch(`/api/channels/${encodeURIComponent(id)}/change-sets`);
    const data = await res.json();
    if (res.ok && Array.isArray(data.changeSets)) {
      setChangeSets(data.changeSets);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/channels");
      const data = await res.json();
      // Only one channel is ever active (docs/decisions/0004-active-channel-read-scoping.md) --
      // there is nothing for the operator to pick.
      if (res.ok && data.channels?.[0]) setChannelId(data.channels[0].channelId);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/ai-connections");
      if (!res.ok) return;
      const data = await res.json();
      setConnections((data.connections ?? []).filter((c: { enabled: boolean }) => c.enabled));
    })();
  }, []);

  useEffect(() => {
    if (channelId) {
      fetchOverview(channelId);
      fetchChangeSets(channelId);
      setPreviewSummary(null);
      setPreviewErrors([]);
      setOpenChangeSetId(null);
    }
  }, [channelId, fetchOverview, fetchChangeSets]);

  async function toggleExpand(videoId: string) {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setDetail(null);
      return;
    }

    setExpandedVideoId(videoId);
    setLoadingDetail(true);
    setDetail(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/localizations/${encodeURIComponent(videoId)}`
      );
      const data = await res.json();
      if (res.ok) setDetail(data);
    } finally {
      setLoadingDetail(false);
    }
  }

  function toggleExportSelected(videoId: string) {
    setExportSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  async function handleExport(scope: "all" | "filtered" | "selected") {
    if (!channelId) return;
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (scope === "selected" && exportSelectedIds.size > 0) {
        params.set("videoIds", [...exportSelectedIds].join(","));
      } else if (scope === "filtered") {
        params.set("videoIds", filteredVideos.map((v) => v.videoId).join(","));
      }

      const url = `/api/channels/${encodeURIComponent(channelId)}/localizations/export${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.message ?? data?.error ?? `Error ${res.status}`);
        return;
      }

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `localizations-${channelId}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  function generateForVideo(videoId: string) {
    setSelectedVideoIds(new Set([videoId]));
    setGenerateOpen(true);
    generateSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleVideoForGeneration(videoId: string) {
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

  async function handleCreateChangeSetFromAi() {
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
          // Echoes back exactly what this generation actually used, so it can be recorded as
          // immutable provenance against the Change Set (AC-PROFILE-08).
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
      await fetchChangeSets(channelId);
      setOpenChangeSetId(data.changeSet.id);
    } finally {
      setCreating(false);
    }
  }

  async function handlePreviewImport() {
    const file = fileInputRef.current?.files?.[0];
    if (!channelId || !file) return;
    setPreviewing(true);
    setError(null);
    setPreviewSummary(null);
    setPreviewErrors([]);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/localizations/import/preview`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setPreviewSummary(data.summary);
      setPreviewErrors(data.errors ?? []);
      setPreviewTotalErrors(data.totalErrors ?? (data.errors ?? []).length);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCreateChangeSetFromXlsx() {
    const file = fileInputRef.current?.files?.[0];
    if (!channelId || !file) return;
    setCreatingChangeSet(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/localizations/import`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setPreviewSummary(null);
      setPreviewErrors([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await fetchChangeSets(channelId);
      setOpenChangeSetId(data.changeSet.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreatingChangeSet(false);
    }
  }

  const filteredVideos = useMemo(() => {
    if (!overview) return [];
    const query = search.trim().toLowerCase();
    if (!query) return overview.videos;
    return overview.videos.filter((v) => v.title.toLowerCase().includes(query));
  }, [overview, search]);

  const filteredChangeSets = useMemo(
    () => changeSets.filter((cs) => matchesSubTab(cs, subTab)),
    [changeSets, subTab]
  );

  return (
    <div className="space-y-4">
      {!channelId && <p className="text-sm text-zinc-400">No channel synchronized yet.</p>}

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>
      )}

      {channelId && (
        <div ref={generateSectionRef} className="rounded-xl border border-indigo-900/60 bg-zinc-900">
          <button
            onClick={() => setGenerateOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-zinc-100"
          >
            <span>Generate with AI</span>
            <span className="text-xs font-normal text-zinc-500">{generateOpen ? "Hide" : "Show"}</span>
          </button>
          {generateOpen && (
            <div className="space-y-4 border-t border-zinc-800 p-4">
              <p className="text-xs text-zinc-500">
                The primary way to add a language to a video. Review and edit the agent&rsquo;s
                output below before creating a Change Set &mdash; nothing is written to YouTube
                from this tab.
              </p>
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
                  A real connection is selected &mdash; generating will make a real request to
                  its configured endpoint and may incur cost.
                </p>
              )}

              <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800">
                {(overview?.videos ?? []).map((v) => (
                  <label
                    key={v.videoId}
                    className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 text-sm text-zinc-300 last:border-b-0 hover:bg-zinc-950"
                  >
                    <input
                      type="checkbox"
                      checked={selectedVideoIds.has(v.videoId)}
                      onChange={() => toggleVideoForGeneration(v.videoId)}
                    />
                    <span className="flex-1 truncate">{v.title}</span>
                    <span className="text-xs text-zinc-500">{v.defaultLanguage ?? "?"}</span>
                  </label>
                ))}
                {(overview?.videos.length ?? 0) === 0 && (
                  <p className="p-3 text-sm text-zinc-500">No synchronized videos for this channel.</p>
                )}
              </div>

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
                    onClick={handleCreateChangeSetFromAi}
                    disabled={creating}
                    className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {creating ? "Creating..." : "Create Change Set from reviewed proposals"}
                  </button>
                </div>
              )}

              {createdChangeSetId && (
                <p className="rounded-md border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">
                  Change Set <code>{createdChangeSetId}</code> created &mdash; see it below.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {channelId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <button
            onClick={() => setImportOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300"
          >
            <span>Import from XLSX (bulk, secondary)</span>
            <span className="text-xs text-zinc-500">{importOpen ? "Hide" : "Show"}</span>
          </button>
          {importOpen && (
            <div className="space-y-3 border-t border-zinc-800 p-4">
              <p className="text-xs text-zinc-500">
                Export the current localization state to XLSX, edit it externally, then upload
                it below to preview proposed changes and create a change set for review. Nothing
                is written to YouTube here or during approval &mdash; imported values remain
                local drafts until a future write phase applies them.
              </p>
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3">
                <button
                  onClick={() => handleExport("selected")}
                  disabled={exporting || exportSelectedIds.size === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Export selected ({exportSelectedIds.size})
                </button>
                <button
                  onClick={() => handleExport("filtered")}
                  disabled={exporting || filteredVideos.length === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Export filtered ({filteredVideos.length})
                </button>
                <button
                  onClick={() => handleExport("all")}
                  disabled={exporting || !overview || overview.totalVideos === 0}
                  className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
                >
                  {exporting ? "Exporting..." : `Export all (${overview?.totalVideos ?? 0})`}
                </button>
                <span className="text-xs text-zinc-500">Select rows to export in the table below.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  className="text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border file:border-zinc-700 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300"
                />
                <button
                  onClick={handlePreviewImport}
                  disabled={previewing}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {previewing ? "Parsing..." : "Preview"}
                </button>
                <button
                  onClick={handleCreateChangeSetFromXlsx}
                  disabled={creatingChangeSet || !previewSummary}
                  className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
                >
                  {creatingChangeSet ? "Creating..." : "Create Change Set"}
                </button>
              </div>

              {previewSummary && (
                <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-zinc-800 px-2 py-1">Videos found: {previewSummary.videosFound}</span>
                    <span className="rounded bg-zinc-800 px-2 py-1">Rows: {previewSummary.localizationRows}</span>
                    <span className="rounded bg-green-900/40 px-2 py-1 text-green-400">
                      Valid changes: {previewSummary.validChanges}
                    </span>
                    <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">
                      Unchanged: {previewSummary.unchangedValues}
                    </span>
                    <span className="rounded bg-red-900/40 px-2 py-1 text-red-400">
                      Invalid: {previewSummary.invalidRows}
                    </span>
                    <span className="rounded bg-amber-900/40 px-2 py-1 text-amber-400">
                      Conflicts: {previewSummary.conflicts}
                    </span>
                  </div>
                  {previewErrors.length > 0 && (
                    <div className="max-h-40 overflow-y-auto rounded border border-zinc-800 p-2 text-xs text-zinc-400">
                      {previewErrors.map((e, i) => (
                        <p key={i}>
                          Row {e.row}
                          {e.videoId ? ` (${e.videoId})` : ""}: {e.message}
                        </p>
                      ))}
                      {previewTotalErrors > previewErrors.length && (
                        <p className="text-zinc-600">...and {previewTotalErrors - previewErrors.length} more</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {channelId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <div className="flex gap-1 rounded-lg bg-zinc-950 p-1">
              {SUB_TABS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setSubTab(t.value)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    subTab === t.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-zinc-500">{filteredChangeSets.length} change set(s)</span>
          </div>
          <div className="p-4">
            {filteredChangeSets.length === 0 ? (
              <p className="text-sm text-zinc-500">No change sets in this view yet.</p>
            ) : (
              <div className="space-y-2">
                {filteredChangeSets.map((cs) => (
                  <button
                    key={cs.id}
                    onClick={() => setOpenChangeSetId(cs.id === openChangeSetId ? null : cs.id)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      openChangeSetId === cs.id
                        ? "border-zinc-500 bg-zinc-800"
                        : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"
                    }`}
                  >
                    <span>
                      {cs.importedFilename ??
                        (cs.source === "ai_localization"
                          ? "AI Generated"
                          : cs.source === "deletion"
                            ? "Deletion"
                            : "XLSX Import")}{" "}
                      ·{" "}
                      {cs.totalChanges} changes · {new Date(cs.createdAt).toLocaleString()}
                    </span>
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase text-zinc-300">
                      {cs.status}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {openChangeSetId && (
              <div className="mt-3">
                <ChangeSetReview
                  channelId={channelId}
                  changeSetId={openChangeSetId}
                  onClose={() => setOpenChangeSetId(null)}
                  onStatusChange={() => fetchChangeSets(channelId)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {overview && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title..."
              className="min-w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm placeholder:text-zinc-600"
            />
            <span className="text-sm text-zinc-400">
              {loadingOverview ? "Loading..." : `${filteredVideos.length} of ${overview.totalVideos} videos`}
            </span>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-8" />
              <col />
              <col className="w-24" />
              <col className="w-32" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 font-medium">Video</th>
                <th className="px-4 py-2 font-medium">Languages</th>
                <th className="px-4 py-2 font-medium">Last modified</th>
              </tr>
            </thead>
            <tbody>
              {filteredVideos.map((video) => (
                <Fragment key={video.videoId}>
                  <tr
                    className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/50"
                    onClick={() => toggleExpand(video.videoId)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={exportSelectedIds.has(video.videoId)}
                        onChange={() => toggleExportSelected(video.videoId)}
                        aria-label={`Select ${video.title} for export`}
                      />
                    </td>
                    <td className="min-w-0 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {video.thumbnailUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={video.thumbnailUrl}
                            alt={video.title}
                            className="h-9 w-14 shrink-0 rounded object-cover"
                          />
                        )}
                        <span className="truncate font-medium">{video.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{video.presentLanguages.length}</td>
                    <td className="truncate px-4 py-3 text-zinc-400">
                      {new Date(video.lastSyncedAt).toLocaleDateString()}
                    </td>
                  </tr>
                  {expandedVideoId === video.videoId && (
                    <tr className="border-b border-zinc-800/50 bg-zinc-950/50">
                      <td colSpan={4} className="px-4 py-4">
                        <div className="mb-3 flex flex-wrap gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              generateForVideo(video.videoId);
                            }}
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                          >
                            Generate with AI for this video
                          </button>
                        </div>
                        {loadingDetail ? (
                          <p className="text-sm text-zinc-500">Loading detail...</p>
                        ) : detail ? (
                          <div className="space-y-3">
                            <div>
                              <p className="text-xs font-medium text-zinc-500">
                                Original / default language: {detail.defaultLanguage ?? "unset"}
                              </p>
                              <p className="text-sm font-medium">{detail.originalTitle}</p>
                              <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                                {detail.originalDescription}
                              </p>
                            </div>
                            {detail.locales.length === 0 ? (
                              <p className="text-xs text-zinc-500">No existing localizations.</p>
                            ) : (
                              <div className="space-y-2 border-t border-zinc-800 pt-3">
                                {detail.locales.map((locale) => (
                                  <div key={locale.language}>
                                    <p className="text-xs font-medium text-zinc-500">{locale.language}</p>
                                    <p className="text-sm">{locale.remoteTitle}</p>
                                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">
                                      {locale.remoteDescription}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-red-400">Failed to load detail.</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>

          {!loadingOverview && filteredVideos.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">No videos match the current search.</p>
          )}
        </div>
      )}
    </div>
  );
}
