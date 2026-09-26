"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import { VideoDetailModal } from "./video-detail-modal";
import { ChangeSetReview } from "./change-set-review";
import { ConfirmDialog } from "./confirm-dialog";

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
  trackedLanguages: string[];
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
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newTrackedLanguage, setNewTrackedLanguage] = useState("");
  const [trackedLanguageBusy, setTrackedLanguageBusy] = useState(false);
  const [trackedLanguageNotice, setTrackedLanguageNotice] = useState<string | null>(null);
  // Drives the shared ConfirmDialog for "remove tracked language" -- null means no dialog is
  // open; hasRealData picks which of the two confirmation messages/actions applies.
  const [pendingRemoveLanguage, setPendingRemoveLanguage] = useState<{ language: string; hasRealData: boolean } | null>(
    null
  );
  // Hard allowlist for "which languages can be added" (owner instruction, 2026-09-21: "Пользователь
  // не может добавить язык, которого не будет в этом списке") -- YouTube's own real, official
  // `i18nLanguages.list` set (hardcoded, `src/lib/youtube-supported-languages.ts`, not fetched
  // live). Only an exact match against this list can be submitted via Enter/Add; the server
  // enforces the identical list independently (`addTrackedLanguage`), this state is UX only.
  const [supportedLanguages, setSupportedLanguages] = useState<{ code: string; name: string }[]>([]);
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  // Which language is shown in the per-video review popup's right (translation) column -- owner
  // instruction, 2026-09-21: a dropdown over the table's own columns (`overview.languages`), not
  // a list of every locale that happens to already exist for this one video, so an operator can
  // also pick a language the video is still MISSING and generate straight from the empty state.
  const [reviewLanguage, setReviewLanguage] = useState<string>("");
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

  async function handleAddTrackedLanguage(explicitLanguage?: string) {
    // Accepts an explicit code (dropdown selection) since setNewTrackedLanguage() before calling
    // this wouldn't be visible yet inside this same closure -- React state updates are async.
    const language = (explicitLanguage ?? newTrackedLanguage).trim();
    if (!channelId || !language) return;
    setTrackedLanguageBusy(true);
    setTrackedLanguageNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/localizations/tracked-languages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setNewTrackedLanguage("");
      await fetchOverview(channelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setTrackedLanguageBusy(false);
    }
  }

  /** Untracks a language column. This is a display preference only -- if the language still has
   * a real localization on at least one video, the column stays visible regardless (it's still
   * part of `overview.languages`'s union), so the notice below explains that rather than letting
   * the operator think nothing happened (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5:
   * real deletion is a separate, not-yet-built capability). */
  /** The "✕" on a language column header branches into two entirely different actions
   * depending on whether real data exists (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md
   * §7.2/E5a+E5b, owner instruction 2026-09-21):
   *   - no real translation anywhere on the channel -> untrack only (E5a, unchanged): a pure,
   *     instant, local display-preference change, nothing to warn about.
   *   - at least one real translation exists -> propose a real (but not immediate) deletion
   *     (E5b) instead. Untracking is deliberately NOT called in this branch -- the column would
   *     stay visible via the real-data union regardless (already explained to the owner), so
   *     untracking here would be a no-op action that could misleadingly read as "handled."
   */
  // Opens the shared in-app ConfirmDialog instead of blocking on window.confirm (owner
  // instruction, 2026-09-21: any popup/dialog this app itself designs must render through our
  // own UI in the app's own style, never a native browser dialog). The actual removal/deletion
  // logic lives in performUntrackLanguage/performProposeLanguageDeletion below, invoked from the
  // dialog's onConfirm once the operator actually clicks through.
  function handleRemoveTrackedLanguage(language: string) {
    if (!channelId) return;
    const hasRealData = (overview?.videos ?? []).some((v) => v.presentLanguages.includes(language));
    setPendingRemoveLanguage({ language, hasRealData });
  }

  async function performUntrackLanguage(language: string) {
    if (!channelId) return;
    setTrackedLanguageBusy(true);
    setTrackedLanguageNotice(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/localizations/tracked-languages/${encodeURIComponent(language)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      await fetchOverview(channelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setTrackedLanguageBusy(false);
    }
  }

  async function performProposeLanguageDeletion(language: string) {
    if (!channelId) return;
    setTrackedLanguageBusy(true);
    setTrackedLanguageNotice(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/localizations/languages/${encodeURIComponent(language)}/propose-deletion`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      const { changeSet, affectedVideoIds, skippedDefaultLanguageVideoIds } = data as {
        changeSet: { id: string } | null;
        affectedVideoIds: string[];
        skippedDefaultLanguageVideoIds: string[];
      };
      if (!changeSet) {
        setTrackedLanguageNotice(
          `Nothing to propose for "${language}" -- every matching video has it as their own ` +
            `default language, which this mechanism never touches (${skippedDefaultLanguageVideoIds.length} skipped).`
        );
      } else {
        setTrackedLanguageNotice(
          `Deletion proposed for "${language}" on ${affectedVideoIds.length} video(s)` +
            (skippedDefaultLanguageVideoIds.length > 0
              ? ` (${skippedDefaultLanguageVideoIds.length} skipped -- it's their default language)`
              : "") +
            ` -- see the new Change Set in the queue below for review/approval.`
        );
        setOpenChangeSetId(changeSet.id);
        await fetchChangeSets(channelId);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTrackedLanguageBusy(false);
    }
  }

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

  // Same "Sync now" action as Content -- deliberately NOT paired with Content's mount-time
  // auto-resync-if-stale policy, which exists there to avoid spending real quota on every tab
  // switch; a manual button here doesn't have that cost, and Languages doesn't need to duplicate
  // Content's staleness bookkeeping to get one. A re-sync can move a video's remote baseline
  // (title/description/localizations), which is exactly what can invalidate an existing approval
  // or raise a fresh conflict (docs/ARCHITECTURE.md §6.7) -- so both the overview table AND the
  // Change Set list are refetched, not just the table.
  const handleSync = useCallback(async () => {
    if (!channelId) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/channels/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setLastSyncedAt(data.channel?.lastSyncedAt ?? null);
      await Promise.all([fetchOverview(channelId), fetchChangeSets(channelId)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [channelId, fetchOverview, fetchChangeSets]);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/channels");
      const data = await res.json();
      // Only one channel is ever active (docs/decisions/0004-active-channel-read-scoping.md) --
      // there is nothing for the operator to pick.
      if (res.ok && data.channels?.[0]) {
        setChannelId(data.channels[0].channelId);
        setLastSyncedAt(data.channels[0].lastSyncedAt ?? null);
      }
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
    (async () => {
      const res = await fetch("/api/youtube/languages");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.languages)) setSupportedLanguages(data.languages);
    })();
  }, []);

  // Excludes columns that already exist (docs/ROADMAP_STATUS.md BL-039's `trackedLanguages ∪
  // real-data` union -- `overview.languages`, not `trackedLanguages` alone, since offering an
  // already-present real-data-only column would look addable but do nothing).
  const addableLanguages = useMemo(() => {
    const existing = new Set(overview?.languages ?? []);
    const query = newTrackedLanguage.trim().toLowerCase();
    return supportedLanguages
      .filter((lang) => !existing.has(lang.code))
      .filter(
        (lang) =>
          query.length === 0 ||
          lang.code.toLowerCase().startsWith(query) ||
          lang.name.toLowerCase().includes(query)
      )
      .slice(0, 50);
  }, [supportedLanguages, overview?.languages, newTrackedLanguage]);

  // Hard gate (owner instruction, 2026-09-21: "Пользователь не может добавить язык, которого не
  // будет в этом списке") -- Enter/Add only submit an exact (case-insensitive) match against
  // SUPPORTED_YOUTUBE_LANGUAGES, never arbitrary typed text; the server enforces the same list
  // independently (localization/services.ts's addTrackedLanguage), this is UX, not the real gate.
  const exactLanguageMatch = useMemo(() => {
    const query = newTrackedLanguage.trim().toLowerCase();
    if (!query) return null;
    return supportedLanguages.find((lang) => lang.code.toLowerCase() === query) ?? null;
  }, [supportedLanguages, newTrackedLanguage]);

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
  //
  // Deliberately does NOT also prune `targets`/`rowErrors` for a video that's merely deselected
  // (not emptied entirely) -- round 6 tried that, on the reasoning that reselecting the same video
  // later should not silently resurrect its old proposal. Reverted the same day: pruning on every
  // deselection cannot tell an accidental double-click (uncheck, recheck) from a deliberate
  // "remove this video, I've moved on" action -- both are the identical uncheck event -- so it
  // destroyed operator edits (and, for a real connection, already-billed generation work) on a
  // misclick, and a later, unrelated selection change could silently make the round-5 "results
  // discarded" notice disappear by pruning the very entries that notice was about. Resurrection
  // itself is not a safety issue: a resurfaced proposal is still just a local, editable draft that
  // goes through the full review -> approve -> Gate-B-blocked-write pipeline before anything real
  // happens, the same as a freshly-generated one -- the approval workflow gates correctness here,
  // not this checkbox. `visibleTargets`/`visibleRowErrors` (derived below) are sufficient on their
  // own: they hide a deselected video's proposal from the *current* view without destroying it,
  // and reselecting simply un-hides it, exactly like toggling any other filter.
  useEffect(() => {
    if (generateScope?.kind === "bulk" && selectedIds.size === 0) {
      closeGeneratePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, generateScope]);

  function closeVideoDetail() {
    // A row-scoped generate panel belongs to whichever video's popup is open -- closing that
    // popup must close the panel with it, not leave it dangling against a video no longer shown.
    if (generateScope?.kind === "row") closeGeneratePanel();
    setExpandedVideoId(null);
    setDetail(null);
  }

  async function openVideoDetail(videoId: string) {
    if (generateScope?.kind === "row") closeGeneratePanel();
    setExpandedVideoId(videoId);
    setLoadingDetail(true);
    setDetail(null);
    const video = overview?.videos.find((v) => v.videoId === videoId);
    const candidates = (overview?.languages ?? []).filter((l) => l !== video?.defaultLanguage);
    setReviewLanguage((current) => (candidates.includes(current) ? current : (candidates[0] ?? "")));
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
      // Applied unconditionally (no selection-filtering at apply time, and `targets` itself is
      // never pruned by anything else either -- see the selection-sync effect above) --
      // `visibleTargets`/`visibleRowErrors` below are the single place that derives what's
      // actually rendered from the live selection, so a response for videos already deselected
      // before it arrives is hidden from view without needing this function to know or care what
      // the selection looked like by the time it resolved (round-5 independent-review finding,
      // 2026-09-21).
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

  // Shared by both memos below so "what counts as still targeted" is defined exactly once
  // (round-7 independent-review finding, 2026-09-21: the same predicate was previously restated
  // verbatim at each call site, risking silent drift between them).
  const isBulkScope = generateScope?.kind === "bulk";
  const stillTargeted = (videoId: string) => !isBulkScope || selectedIds.has(videoId);

  /** What the review panel actually shows -- always a subset of `targets` consistent with the
   * live selection for a bulk session (row sessions have exactly one video, nothing to filter).
   * Deriving this instead of imperatively pruning `targets` itself makes "never show a proposal
   * for a video that isn't targeted anymore" true by construction (round-5 independent-review
   * finding, 2026-09-21 -- see the comment in handleGenerate for why the previous apply-time +
   * effect-time double-filtering approach kept reopening variants of this same bug; see the
   * selection-sync effect above for why round 6's attempt to *also* prune `targets` itself was
   * reverted the same day). Deselecting a video hides its proposal here; reselecting it un-hides
   * the same proposal rather than requiring a fresh, possibly-billed regenerate -- intentional,
   * not a bug, since the approval workflow downstream is what actually gates anything real. */
  const visibleTargets = useMemo(
    () => targets.filter((t) => stillTargeted(t.videoId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, selectedIds, generateScope]
  );
  const visibleRowErrors = useMemo(
    () => rowErrors.filter((e) => e.videoId === null || stillTargeted(e.videoId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Looked up from the full `overview.videos` list, not the search-filtered/sorted view, so the
  // popup stays open and correct even if the operator changes the search or sort while it's open.
  const expandedVideo = expandedVideoId ? (overview?.videos.find((v) => v.videoId === expandedVideoId) ?? null) : null;

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

  /** The content of the video-detail popup for this tab -- a wide, two-column original/translation
   * layout (owner instruction, 2026-09-21: "слева оригинальный язык... справа один из
   * переводов... дропдаун какой именно язык хочу выбрать"), plus the inline "Generate with AI"
   * mini-form/review panel below. Rendered inside the shared `VideoDetailModal` shell
   * (`video-detail-modal.tsx`, widened via `widthClassName` for this tab specifically), which owns
   * the popup chrome itself; only what's inside differs per tab, per the owner's own framing.
   * The right column's language dropdown is sourced from `overview.languages` (the same
   * tracked-∪-real-data union the table's own columns show), not from `detail.locales` alone --
   * this lets the operator pick a language the video is still MISSING and generate straight from
   * the resulting empty state, not only browse what already exists. */
  function renderVideoLocalizationDetail(video: OverviewRow) {
    const languageOptions = (overview?.languages ?? []).filter((l) => l !== video.defaultLanguage);
    const selectedLocale = detail?.locales.find((l) => l.language === reviewLanguage) ?? null;

    return (
      <div className="flex h-full flex-col">
        {loadingDetail ? (
          <p className="text-sm text-zinc-500">Loading detail...</p>
        ) : detail ? (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
            <div className="flex min-h-0 flex-col">
              <p className="mb-1 shrink-0 text-xs font-medium text-zinc-500">
                Original / default language: {detail.defaultLanguage ?? "unset"}
              </p>
              <div className="mb-2 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <p className="text-sm font-medium text-zinc-100">{detail.originalTitle}</p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <p className="whitespace-pre-wrap text-xs text-zinc-400">{detail.originalDescription}</p>
              </div>
            </div>

            <div className="flex min-h-0 flex-col">
              <select
                value={reviewLanguage}
                onChange={(e) => setReviewLanguage(e.target.value)}
                disabled={languageOptions.length === 0}
                className="mb-2 shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
              >
                {languageOptions.length === 0 ? (
                  <option value="">No other tracked languages</option>
                ) : (
                  languageOptions.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))
                )}
              </select>
              {selectedLocale ? (
                <>
                  <div className="mb-2 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <p className="text-sm font-medium text-zinc-100">{selectedLocale.remoteTitle}</p>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <p className="whitespace-pre-wrap text-xs text-zinc-400">{selectedLocale.remoteDescription}</p>
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-4 text-center">
                  <p className="text-xs text-zinc-500">
                    {languageOptions.length === 0
                      ? "Add a language column in the table first."
                      : `No "${reviewLanguage}" translation yet for this video.`}
                  </p>
                  {reviewLanguage && (
                    <button
                      onClick={() => {
                        startRowGenerate(video.videoId);
                        setTargetLanguages(reviewLanguage);
                      }}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      Generate with AI for this language
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-red-400">Failed to load detail.</p>
        )}

        <div className="mt-4 shrink-0 border-t border-zinc-800 pt-4">
          {isRowGeneratePanelOpen(video.videoId) ? (
            renderGenerationPanel()
          ) : (
            <button
              onClick={() => startRowGenerate(video.videoId)}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Generate with AI for this video
            </button>
          )}
        </div>
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
          <p className="text-xs text-zinc-500">
            Last synced: {lastSyncedAt ? formatDisplayDateTime(lastSyncedAt) : "never"}
          </p>
        </div>
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
            <div className="relative flex items-center gap-2">
              <input
                type="text"
                value={newTrackedLanguage}
                onChange={(e) => {
                  setNewTrackedLanguage(e.target.value);
                  setLanguageDropdownOpen(true);
                }}
                onFocus={() => setLanguageDropdownOpen(true)}
                onBlur={() => setLanguageDropdownOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && exactLanguageMatch) {
                    setLanguageDropdownOpen(false);
                    handleAddTrackedLanguage(exactLanguageMatch.code);
                  }
                  if (e.key === "Escape") setLanguageDropdownOpen(false);
                }}
                placeholder="Add language column (search by code or name)"
                className="w-56 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm placeholder:text-zinc-600"
              />
              <button
                onClick={() => exactLanguageMatch && handleAddTrackedLanguage(exactLanguageMatch.code)}
                disabled={trackedLanguageBusy || !exactLanguageMatch}
                title={
                  newTrackedLanguage.trim() && !exactLanguageMatch
                    ? "Pick a language from YouTube's supported list below"
                    : undefined
                }
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
              >
                Add
              </button>

              {languageDropdownOpen && addableLanguages.length > 0 && (
                <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 shadow-lg">
                  {addableLanguages.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      // Keeps focus on the input so `onBlur` above never fires before this click
                      // is handled -- no setTimeout-based "wait for the click" workaround needed.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setLanguageDropdownOpen(false);
                        handleAddTrackedLanguage(lang.code);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-700"
                    >
                      {lang.code} &mdash; {lang.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="text-sm text-zinc-400">
              {loadingOverview ? "Loading..." : `${sortedFilteredVideos.length} of ${overview.totalVideos} videos`}
            </span>
          </div>

          {trackedLanguageNotice && (
            <p className="border-b border-zinc-800 bg-amber-950/20 px-4 py-2 text-xs text-amber-300">
              {trackedLanguageNotice}
            </p>
          )}

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
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => handleSort(`${LANG_SORT_PREFIX}${lang}`)} className="hover:text-zinc-300">
                          {lang}
                          {sortIndicator(`${LANG_SORT_PREFIX}${lang}`, sort)}
                        </button>
                        <button
                          onClick={() => handleRemoveTrackedLanguage(lang)}
                          disabled={trackedLanguageBusy}
                          className="text-zinc-600 hover:text-red-400 disabled:opacity-50"
                          title={`Remove "${lang}" column`}
                          aria-label={`Remove ${lang} column`}
                        >
                          &#10005;
                        </button>
                      </div>
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
                    <tr
                      key={video.videoId}
                      className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/50"
                      onClick={() => openVideoDetail(video.videoId)}
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
                        {formatDisplayDate(video.publishedAt)}
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
                        {formatDisplayDate(video.lastSyncedAt)}
                      </td>
                    </tr>
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
                      {cs.totalChanges} changes &middot; {formatDisplayDateTime(cs.createdAt)}
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

      {expandedVideo && (
        <VideoDetailModal
          title={expandedVideo.title}
          thumbnailUrl={expandedVideo.thumbnailUrl}
          onClose={closeVideoDetail}
          // A pending, not-yet-submitted AI review (proposals generated but "Create Change Set"
          // never clicked) counts as unsaved work -- closing the popup would otherwise silently
          // discard it, including any hand-edited text (owner instruction, 2026-09-21).
          hasUnsavedChanges={isRowGeneratePanelOpen(expandedVideo.videoId) && visibleTargets.length > 0}
          // Wider than Content's default (owner instruction, 2026-09-21) for the side-by-side
          // original/translation layout below.
          widthClassName="max-w-7xl"
        >
          {renderVideoLocalizationDetail(expandedVideo)}
        </VideoDetailModal>
      )}

      {pendingRemoveLanguage && (
        <ConfirmDialog
          title={
            pendingRemoveLanguage.hasRealData
              ? `Propose deleting "${pendingRemoveLanguage.language}"?`
              : `Remove "${pendingRemoveLanguage.language}" from tracked languages?`
          }
          description={
            pendingRemoveLanguage.hasRealData
              ? `"${pendingRemoveLanguage.language}" has real translations on this channel. This will propose ` +
                `DELETING that localization (title + description) from every video that has it -- this does NOT ` +
                `delete anything immediately: it creates a Change Set that still needs your approval, a backup of ` +
                `the current values is captured automatically when the batch pipeline processes it, and nothing ` +
                `can actually be written to YouTube until Gate B is cleared. The column will remain visible until ` +
                `that eventually happens and the channel re-syncs.`
              : undefined
          }
          confirmLabel={pendingRemoveLanguage.hasRealData ? "Propose deletion" : "Remove"}
          confirmVariant="danger"
          onCancel={() => setPendingRemoveLanguage(null)}
          onConfirm={() => {
            const { language, hasRealData } = pendingRemoveLanguage;
            setPendingRemoveLanguage(null);
            if (hasRealData) {
              void performProposeLanguageDeletion(language);
            } else {
              void performUntrackLanguage(language);
            }
          }}
        />
      )}
    </div>
  );
}
