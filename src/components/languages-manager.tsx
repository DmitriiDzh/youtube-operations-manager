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

// --- Sorting (E1, docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.3) ---

/** "title" | "publishedAt" | "lastSyncedAt" | `lang:${code}` -- a plain string rather than a
 * union-with-object so it can double as a React key and a stable useMemo dependency. */
type SortKey = string;
type SortDirection = "asc" | "desc";
type SortState = { key: SortKey; direction: SortDirection };

const DEFAULT_SORT: SortState = { key: "publishedAt", direction: "desc" };
const LANG_SORT_PREFIX = "lang:";

function compareRows(a: OverviewRow, b: OverviewRow, key: SortKey): number {
  if (key === "title") return a.title.localeCompare(b.title);
  if (key === "publishedAt") return a.publishedAt.localeCompare(b.publishedAt);
  if (key === "lastSyncedAt") return a.lastSyncedAt.localeCompare(b.lastSyncedAt);
  if (key.startsWith(LANG_SORT_PREFIX)) {
    const lang = key.slice(LANG_SORT_PREFIX.length);
    const aPresent = a.presentLanguages.includes(lang) ? 1 : 0;
    const bPresent = b.presentLanguages.includes(lang) ? 1 : 0;
    return aPresent - bPresent;
  }
  return 0;
}

/** Sort direction an operator would expect the FIRST time they click a given column -- newest
 * publish/sync date first (matches the pre-existing default order), title A-Z, and for a
 * language column, missing-first (the whole point of sorting by a language is usually "show me
 * who still needs this translation"). A second click on the same column flips it either way. */
function defaultDirectionFor(key: SortKey): SortDirection {
  if (key === "title") return "asc";
  if (key.startsWith(LANG_SORT_PREFIX)) return "asc";
  return "desc";
}

function sortIndicator(key: SortKey, sort: SortState): string {
  if (sort.key !== key) return "";
  return sort.direction === "asc" ? " ▲" : " ▼";
}

// --- AI generation targeting scope (E4, §4.2/§4.3) ---

/** Which surface last triggered a generation session -- the bulk popover (driven by the table's
 * own row checkboxes) or one specific row's own inline mini-form. Both funnel into the exact same
 * generate/review/create-change-set state and API calls below; only where the resulting review
 * panel renders differs. */
type GenerateScope = { kind: "bulk" } | { kind: "row"; videoId: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The "Languages" tab. One table drives everything (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md,
 * slices E1-E4b, assigned 2026-09-21): sortable columns (E1), a real per-language present/missing
 * grid instead of a bare count (E2, undoing an earlier restyle per that plan's §7.1), a per-language
 * bulk "add missing translation" shortcut (E3), a contextual bulk-action bar plus inline per-video
 * generate/review replacing the old always-open top-of-page checklist (E4), and a static
 * "Recommended languages" placeholder pending the Phase 8 Analytics integration (E4b). One shared
 * selection set now drives both AI generation and XLSX export (previously two independent sets).
 *
 * Sub-tabs ("Все/В процессе/Одобрено") mirror Studio's own Languages page but are mapped onto this
 * app's real unit of work -- a Change Set's approval status, not a per-video "draft/published"
 * state Studio's literal UI assumes and this app's batch/approval workflow doesn't have.
 * "Одобрено" never means "Опубликовано" -- Phase 5 live YouTube writes remain barrier-disabled
 * (docs/TECHNICAL_DEBT.md RISK-09).
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
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const [changeSets, setChangeSets] = useState<ChangeSetSummary[]>([]);
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [openChangeSetId, setOpenChangeSetId] = useState<string | null>(null);

  // --- One shared row-selection set (E4/§4.5) -- drives both AI generation and XLSX export. ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Always mirrors the latest `selectedIds` -- `handleGenerate` is an async closure created at
  // the moment "Generate proposals" was clicked, so its own `selectedIds` reference is frozen to
  // whatever the selection was THEN; reading this ref instead, once the response actually
  // arrives, lets it filter against what is selected NOW (round-4 independent-review finding,
  // 2026-09-21: deselecting one video while a bulk request was still in flight was not caught by
  // the round-3 selection-sync effect, since `targets` was still empty at the moment of
  // deselection -- there was nothing yet to filter).
  const selectedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // --- AI generation (primary path) ---
  // Popover visibility for the bulk path is deliberately NOT its own boolean -- it is derived
  // from `generateScope?.kind === "bulk"` below (independent-review finding, 2026-09-21: a
  // separate `bulkPopoverOpen` boolean had already desynced from `generateScope` at one call site
  // and was one edit away from doing so again at every other one).
  const [generateScope, setGenerateScope] = useState<GenerateScope | null>(null);
  // Bumped by resetGenerationSession() and by handleGenerate() itself on every call -- a fetch's
  // response is only ever applied if this still matches the value captured when that fetch
  // started, so a slow/superseded request can never land its result into whatever session is
  // open by the time it resolves (round-2 independent-review finding, 2026-09-21).
  const generationRequestIdRef = useRef(0);
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

  /** Invalidates whatever `handleGenerate()` request is currently in flight -- a response that
   * arrives after this is bumped is recognized as stale and never applied. Deliberately does
   * NOT touch `generating` (round-3 independent-review finding, 2026-09-21: an earlier version of
   * `resetGenerationSession` force-cleared `generating` here, which re-enabled "Generate
   * proposals" while a real, possibly billed request from the abandoned session was still
   * in flight -- letting the operator fire a second real provider call concurrently with the
   * first. `generating` is now only ever cleared by the specific fetch that set it true, in its
   * own `finally`, so at most one real generate request can be in flight from this component at
   * any time, regardless of how many sessions are opened and abandoned while it runs.) */
  function bumpGenerationRequestId() {
    generationRequestIdRef.current += 1;
  }

  /** Clears whatever the previous generation session produced -- shared by every path that starts
   * or ends one (independent-review finding, 2026-09-21: startBulkGenerate/
   * startBulkGenerateForLanguage previously skipped this, so switching from an open row-scoped
   * session straight into a bulk one could silently carry the earlier video's proposals into a
   * Change Set for a completely different target). */
  function resetGenerationSession() {
    bumpGenerationRequestId();
    setTargets([]);
    setRowErrors([]);
    setCreatedChangeSetId(null);
    setGenerationContext(null);
  }

  function closeGeneratePanel() {
    setGenerateScope(null);
    resetGenerationSession();
  }

  function isRowGeneratePanelOpen(videoId: string): boolean {
    return generateScope?.kind === "row" && generateScope.videoId === videoId;
  }

  // Closes a bulk-scoped session once its selection is entirely empty -- there is nothing left
  // for it to be scoped to (round-2 independent-review finding, 2026-09-21: this must fire
  // regardless of which code path emptied the selection -- "Clear" or unchecking the last row).
  // Deselecting only SOME of several selected videos no longer needs handling here: `targets`
  // itself is left alone, and `visibleTargets`/`visibleRowErrors` (derived above) already filter
  // what's displayed/submitted against the live selection, so there is nothing left to prune
  // imperatively (round-5 independent-review finding, 2026-09-21 -- see handleGenerate's comment
  // for why the previous version of this effect duplicated that filtering here too).
  useEffect(() => {
    if (generateScope?.kind === "bulk" && selectedIds.size === 0) {
      closeGeneratePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, generateScope]);

  async function toggleExpand(videoId: string) {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setDetail(null);
      if (isRowGeneratePanelOpen(videoId)) closeGeneratePanel();
      return;
    }

    // Switching to a different row -- a row-scoped generate panel belongs to the row that was
    // expanded when it was opened, never a different one.
    if (generateScope?.kind === "row") closeGeneratePanel();

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

  function toggleSelected(videoId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  function handleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "asc" ? "desc" : "asc" } : { key, direction: defaultDirectionFor(key) }));
  }

  async function handleExport(scope: "all" | "filtered" | "selected") {
    if (!channelId) return;
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (scope === "selected" && selectedIds.size > 0) {
        params.set("videoIds", [...selectedIds].join(","));
      } else if (scope === "filtered") {
        params.set("videoIds", sortedFilteredVideos.map((v) => v.videoId).join(","));
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

  function startBulkGenerate() {
    resetGenerationSession();
    setGenerateScope({ kind: "bulk" });
  }

  /** E3 (§7.5): "add this language to every video missing it" -- replaces the selection with
   * exactly the videos missing `lang` (channel-wide, not just the current search) and opens the
   * same bulk-generate popover pre-filled with that language. Per the plan this deliberately
   * replaces whatever selection existed before, in one click -- not a bug, the specified behavior. */
  function startBulkGenerateForLanguage(lang: string) {
    const missingIds = (overview?.videos ?? []).filter((v) => v.missingLanguages.includes(lang)).map((v) => v.videoId);
    resetGenerationSession();
    setSelectedIds(new Set(missingIds));
    setTargetLanguages(lang);
    setGenerateScope({ kind: "bulk" });
  }

  function startRowGenerate(videoId: string) {
    resetGenerationSession();
    setGenerateScope({ kind: "row", videoId });
  }

  async function handleGenerate() {
    if (!generateScope) return;
    setError(null);
    setCreatedChangeSetId(null);
    const languages = targetLanguages
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const videoIds = generateScope.kind === "bulk" ? [...selectedIds] : [generateScope.videoId];
    if (videoIds.length === 0 || languages.length === 0) {
      setError("Select at least one video and one target language");
      return;
    }

    // Captured before the request starts; bumpGenerationRequestId() (called whenever this session
    // is abandoned or superseded -- closing the panel, switching row<->bulk, Clear, the selection
    // emptying) invalidates it, so a response that arrives after that point is recognized as
    // stale below and never applied to the (now different, or gone) review UI (round-2
    // independent-review finding, 2026-09-21). `generating` itself is intentionally NOT gated by
    // this staleness check -- see bumpGenerationRequestId's doc comment (round-3 finding): it is
    // this specific request's own `finally`, unconditionally, so at most one real generate request
    // can ever be in flight from this component regardless of session switches in the meantime.
    bumpGenerationRequestId();
    const requestId = generationRequestIdRef.current;
    // Computed at the point of use (not frozen here) so an error message reflects what is
    // actually selected/open NOW, not what it was when this request started (round-5
    // independent-review finding, 2026-09-21: a frozen label could overstate a stale video count
    // if the operator deselected some videos while the request was still in flight).
    const currentRequestLabel = () =>
      generateScope.kind === "row" ? `video ${generateScope.videoId}` : `${selectedIdsRef.current.size} selected video(s)`;
    setGenerating(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/ai-localization/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoIds,
          targetLanguages: languages,
          ...(connectionId ? { connectionId } : {}),
        }),
      });
      const data = (await res.json()) as GenerationResponse & { message?: string };
      if (!res.ok) {
        // Surfaced unconditionally, even for an abandoned/superseded session (round-3
        // independent-review finding, 2026-09-21: a real provider failure -- quota, invalid key,
        // outage -- must reach the operator even if they've already moved on from this specific
        // panel; only the panel's own review UI below is gated by staleness, not error visibility).
        // Known, accepted limitation (docs/TECHNICAL_DEBT.md RISK-44): this shares one global
        // error banner with every other action in the tab, so it can in principle be immediately
        // overwritten by an unrelated error -- the same pre-existing property every handler in
        // this file already has, not something new here.
        setError(`Generation for ${currentRequestLabel()} failed: ${data.message ?? "Generation failed"}`);
        return;
      }
      if (requestId !== generationRequestIdRef.current) return;
      // Applied unconditionally (no selection-filtering here) -- `visibleTargets`/
      // `visibleRowErrors` below derive what's actually shown from live `targets` + `selectedIds`
      // + `generateScope`, so the "only show proposals for currently-selected videos" invariant
      // holds by construction instead of needing to be re-applied at every point that can change
      // either input (round-5 independent-review finding, 2026-09-21: filtering only at
      // apply-time here, plus a separate imperative prune in a `useEffect`, was two independently
      // maintained copies of the same invariant -- exactly the kind of duplication that had
      // already let a variant of this bug through three rounds in a row).
      setTargets(data.results.map(toEditable));
      setRowErrors(data.errors);
      setGenerationContext(data.generationContext);
    } catch (e) {
      // Round-4 independent-review finding, 2026-09-21: unlike every other async handler in this
      // file (fetchOverview, handleExport, handlePreviewImport, ...), this one had no catch --
      // a network failure or a non-JSON error body threw past both branches above, silently
      // clearing `generating` via `finally` with no error ever shown to the operator.
      setError(`Generation for ${currentRequestLabel()} failed: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  /** What the review panel actually shows -- always a subset of `targets` consistent with the
   * live selection for a bulk session (row sessions have exactly one video, nothing to filter).
   * Deriving this instead of imperatively pruning `targets` itself makes "never show a proposal
   * for a video that isn't targeted anymore" true by construction (round-5 independent-review
   * finding, 2026-09-21 -- see the comment in handleGenerate for why the previous apply-time +
   * effect-time double-filtering approach kept reopening variants of this same bug). */
  const visibleTargets = useMemo(
    () => (generateScope?.kind === "bulk" ? targets.filter((t) => selectedIds.has(t.videoId)) : targets),
    [targets, selectedIds, generateScope]
  );
  const visibleRowErrors = useMemo(
    () =>
      generateScope?.kind === "bulk" ? rowErrors.filter((e) => e.videoId === null || selectedIds.has(e.videoId)) : rowErrors,
    [rowErrors, selectedIds, generateScope]
  );
  /** True when a bulk request actually returned proposals but every one of them was for a video
   * no longer selected -- surfaced as an explanatory note rather than silently rendering nothing,
   * which gave the operator no sign that a completed (and, for a real connection, possibly
   * billed) request's result was entirely discarded (round-5 independent-review finding,
   * 2026-09-21). */
  const allResultsDiscardedBySelectionChange = targets.length > 0 && visibleTargets.length === 0;

  // Identified by (videoId, language), not array position -- the review list below renders
  // `visibleTargets` (a filtered view of `targets`), so an index into that filtered array would
  // no longer line up with the same entry's real position in the underlying `targets` state.
  function updateTarget(videoId: string, language: string, patch: Partial<EditableTarget>) {
    setTargets((prev) => prev.map((t) => (t.videoId === videoId && t.language === language ? { ...t, ...patch } : t)));
  }

  async function handleCreateChangeSetFromAi() {
    setError(null);
    // From `visibleTargets`, not raw `targets` -- a video the operator has since deselected must
    // never be submitted into the Change Set just because its proposal is still sitting in state
    // (round-5 independent-review finding, 2026-09-21).
    const proposals = visibleTargets
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
      setRowErrors([]);
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

  const sortedFilteredVideos = useMemo(() => {
    const copy = [...filteredVideos];
    copy.sort((a, b) => {
      const cmp = compareRows(a, b, sort.key);
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filteredVideos, sort]);

  const missingCountByLanguage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lang of overview?.languages ?? []) {
      counts.set(lang, (overview?.videos ?? []).filter((v) => v.missingLanguages.includes(lang)).length);
    }
    return counts;
  }, [overview]);

  const filteredChangeSets = useMemo(
    () => changeSets.filter((cs) => matchesSubTab(cs, subTab)),
    [changeSets, subTab]
  );

  const languages = overview?.languages ?? [];
  const tableMinWidth = Math.max(600, 420 + languages.length * 56);

  /** Shared generate/review/create-change-set panel, rendered either inside the bulk popover or
   * inside one row's expanded detail depending on `generateScope` (E4, §4.2/§4.3) -- one
   * implementation, not two copies that could drift. */
  function renderGenerationPanel() {
    return (
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          Review and edit the agent&rsquo;s output below before creating a Change Set &mdash;
          nothing is written to YouTube from this panel.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={targetLanguages}
            onChange={(e) => setTargetLanguages(e.target.value)}
            placeholder="Target language(s), comma-separated (e.g. es, de, pt-BR)"
            className="min-w-[220px] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
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
          <button onClick={closeGeneratePanel} className="text-xs text-zinc-500 hover:text-zinc-300">
            Close
          </button>
        </div>
        {connectionId && (
          <p className="text-xs text-amber-400">
            A real connection is selected &mdash; generating will make a real request to its
            configured endpoint and may incur cost.
          </p>
        )}

        {visibleRowErrors.length > 0 && (
          <div className="rounded-md border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
            {visibleRowErrors.map((e, i) => (
              <p key={i}>
                {e.videoId ?? "?"} / {e.language ?? "?"}: {e.message}
              </p>
            ))}
          </div>
        )}

        {allResultsDiscardedBySelectionChange && (
          <p className="rounded-md border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
            The selection changed before this request finished, so none of its results still apply
            &mdash; regenerate for the videos you have selected now.
          </p>
        )}

        {visibleTargets.length > 0 && (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto">
            <h3 className="text-sm font-semibold text-zinc-200">Review &amp; edit proposals</h3>
            {visibleTargets.map((t) => (
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
                          onChange={(e) => updateTarget(t.videoId, t.language, { includeTitle: e.target.checked })}
                        />
                        Title
                      </span>
                      <textarea
                        value={t.editedTitle}
                        onChange={(e) => updateTarget(t.videoId, t.language, { editedTitle: e.target.value })}
                        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                        rows={2}
                      />
                    </label>
                    <label className="block">
                      <span className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={t.includeDescription}
                          onChange={(e) => updateTarget(t.videoId, t.language, { includeDescription: e.target.checked })}
                        />
                        Description
                      </span>
                      <textarea
                        value={t.editedDescription}
                        onChange={(e) => updateTarget(t.videoId, t.language, { editedDescription: e.target.value })}
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
            Change Set <code>{createdChangeSetId}</code> created &mdash; see it in the queue below.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!channelId && <p className="text-sm text-zinc-400">No channel synchronized yet.</p>}

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>
      )}

      {channelId && (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs text-zinc-500">
          <span className="font-medium text-zinc-400">Recommended languages</span> &mdash; coming with
          Analytics integration (Phase 8). Once real audience data is available, this card will
          suggest languages for this channel with a one-click apply.
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
              {loadingOverview ? "Loading..." : `${sortedFilteredVideos.length} of ${overview.totalVideos} videos`}
            </span>
          </div>

          {selectedIds.size > 0 && (
            <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-medium text-zinc-200">{selectedIds.size} selected</span>
                <button onClick={() => setSelectedIds(new Set())} className="text-xs text-zinc-500 hover:text-zinc-300">
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={startBulkGenerate}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                >
                  Generate with AI &#9662;
                </button>
                <button
                  onClick={() => handleExport("selected")}
                  disabled={exporting}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Export to XLSX
                </button>
              </div>

              {generateScope?.kind === "bulk" && (
                <div className="absolute right-4 top-full z-10 mt-2 w-[420px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
                  {renderGenerationPanel()}
                </div>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: tableMinWidth }}>
              <thead>
                <tr className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
                  <th className="w-8 px-4 py-2 font-medium" />
                  <th className="px-4 py-2 font-medium">
                    <button onClick={() => handleSort("title")} className="hover:text-zinc-300">
                      Video{sortIndicator("title", sort)}
                    </button>
                  </th>
                  <th className="w-24 px-4 py-2 font-medium">
                    <button onClick={() => handleSort("publishedAt")} className="hover:text-zinc-300">
                      Published{sortIndicator("publishedAt", sort)}
                    </button>
                  </th>
                  {languages.map((lang) => (
                    <th key={lang} className="w-14 px-2 py-2 text-center font-medium">
                      <button onClick={() => handleSort(`${LANG_SORT_PREFIX}${lang}`)} className="block w-full hover:text-zinc-300">
                        {lang}
                        {sortIndicator(`${LANG_SORT_PREFIX}${lang}`, sort)}
                      </button>
                      {(missingCountByLanguage.get(lang) ?? 0) > 0 && (
                        <button
                          onClick={() => startBulkGenerateForLanguage(lang)}
                          className="mt-0.5 block w-full text-center text-[10px] font-normal normal-case text-indigo-400 hover:text-indigo-300"
                          title={`Add "${lang}" translation to ${missingCountByLanguage.get(lang)} video(s) missing it`}
                        >
                          +{missingCountByLanguage.get(lang)}
                        </button>
                      )}
                    </th>
                  ))}
                  <th className="w-32 px-4 py-2 font-medium">
                    <button onClick={() => handleSort("lastSyncedAt")} className="hover:text-zinc-300">
                      Last modified{sortIndicator("lastSyncedAt", sort)}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedFilteredVideos.map((video) => (
                  <Fragment key={video.videoId}>
                    <tr
                      className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/50"
                      onClick={() => toggleExpand(video.videoId)}
                    >
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(video.videoId)}
                          onChange={() => toggleSelected(video.videoId)}
                          aria-label={`Select ${video.title}`}
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
                      <td className="truncate px-4 py-3 text-zinc-400">
                        {new Date(video.publishedAt).toLocaleDateString()}
                      </td>
                      {languages.map((lang) => (
                        <td key={lang} className="px-2 py-3 text-center">
                          {video.presentLanguages.includes(lang) ? (
                            <span className="text-emerald-400" title={`${lang}: translated`}>
                              &#10003;
                            </span>
                          ) : (
                            <span className="text-zinc-700" title={`${lang}: missing`}>
                              &mdash;
                            </span>
                          )}
                        </td>
                      ))}
                      <td className="truncate px-4 py-3 text-zinc-400">
                        {new Date(video.lastSyncedAt).toLocaleDateString()}
                      </td>
                    </tr>
                    {expandedVideoId === video.videoId && (
                      <tr className="border-b border-zinc-800/50 bg-zinc-950/50">
                        <td colSpan={4 + languages.length} className="px-4 py-4">
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

                          <div className="mt-4 border-t border-zinc-800 pt-4">
                            {isRowGeneratePanelOpen(video.videoId) ? (
                              renderGenerationPanel()
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startRowGenerate(video.videoId);
                                }}
                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                              >
                                Generate with AI for this video
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {!loadingOverview && sortedFilteredVideos.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">No videos match the current search.</p>
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
            <span className="text-xs text-zinc-500">Awaiting review across all videos &middot; {filteredChangeSets.length} change set(s)</span>
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
                      &middot;{" "}
                      {cs.totalChanges} changes &middot; {new Date(cs.createdAt).toLocaleString()}
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
                  disabled={exporting || selectedIds.size === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Export selected ({selectedIds.size})
                </button>
                <button
                  onClick={() => handleExport("filtered")}
                  disabled={exporting || sortedFilteredVideos.length === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Export filtered ({sortedFilteredVideos.length})
                </button>
                <button
                  onClick={() => handleExport("all")}
                  disabled={exporting || !overview || overview.totalVideos === 0}
                  className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
                >
                  {exporting ? "Exporting..." : `Export all (${overview?.totalVideos ?? 0})`}
                </button>
                <span className="text-xs text-zinc-500">Select rows in the table above to export.</span>
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
    </div>
  );
}
