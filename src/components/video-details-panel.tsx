"use client";

import { useCallback, useEffect, useState } from "react";

type VideoDetailsSnapshot = {
  videoId: string;
  etag: string | null;
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  license: string | null;
  embeddable: boolean | null;
  publicStatsViewable: boolean | null;
  selfDeclaredMadeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  recordingDate: string | null;
};

type FormValues = {
  title: string;
  description: string;
  tagsText: string;
  categoryId: string;
  defaultLanguage: string;
  privacyStatus: string;
  publishAt: string;
  license: string;
  embeddable: boolean;
  publicStatsViewable: boolean;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia: boolean;
  recordingDate: string;
};

type Patch = Record<string, unknown>;

function toFormValues(s: VideoDetailsSnapshot): FormValues {
  return {
    title: s.title,
    description: s.description,
    tagsText: s.tags.join(", "),
    categoryId: s.categoryId ?? "",
    defaultLanguage: s.defaultLanguage ?? "",
    privacyStatus: s.privacyStatus ?? "private",
    publishAt: s.publishAt ?? "",
    license: s.license ?? "youtube",
    embeddable: s.embeddable ?? true,
    publicStatsViewable: s.publicStatsViewable ?? true,
    selfDeclaredMadeForKids: s.selfDeclaredMadeForKids ?? false,
    containsSyntheticMedia: s.containsSyntheticMedia ?? false,
    recordingDate: s.recordingDate ?? "",
  };
}

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Only the fields the operator actually changed, diffed against the snapshot the form was
 * loaded from -- never the whole form. `publishAt` is the one documented exception (the API
 * requires `privacyStatus: "private"` in the same request): if publishAt is being newly set,
 * privacyStatus is always included even when the operator didn't touch it. */
function buildPatch(form: FormValues, original: VideoDetailsSnapshot): Patch {
  const patch: Patch = {};
  if (form.title !== original.title) patch.title = form.title;
  if (form.description !== original.description) patch.description = form.description;
  const tags = parseTags(form.tagsText);
  if (JSON.stringify(tags) !== JSON.stringify(original.tags)) patch.tags = tags;
  if (form.categoryId && form.categoryId !== (original.categoryId ?? "")) patch.categoryId = form.categoryId;
  if (form.defaultLanguage && form.defaultLanguage !== (original.defaultLanguage ?? "")) {
    patch.defaultLanguage = form.defaultLanguage;
  }
  if (form.privacyStatus !== (original.privacyStatus ?? "private")) patch.privacyStatus = form.privacyStatus;
  if (form.publishAt && form.publishAt !== (original.publishAt ?? "")) {
    patch.publishAt = new Date(form.publishAt).toISOString();
    patch.privacyStatus = "private";
  }
  if (form.license !== (original.license ?? "youtube")) patch.license = form.license;
  if (form.embeddable !== (original.embeddable ?? true)) patch.embeddable = form.embeddable;
  if (form.publicStatsViewable !== (original.publicStatsViewable ?? true)) {
    patch.publicStatsViewable = form.publicStatsViewable;
  }
  if (form.selfDeclaredMadeForKids !== (original.selfDeclaredMadeForKids ?? false)) {
    patch.selfDeclaredMadeForKids = form.selfDeclaredMadeForKids;
  }
  if (form.containsSyntheticMedia !== (original.containsSyntheticMedia ?? false)) {
    patch.containsSyntheticMedia = form.containsSyntheticMedia;
  }
  if (form.recordingDate && form.recordingDate !== (original.recordingDate ?? "")) {
    patch.recordingDate = new Date(form.recordingDate).toISOString();
  }
  return patch;
}

function patchesEqual(a: Patch | null, b: Patch): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Studio-parity "Details" panel for one video (`docs/roadmap/BACKLOG.md` BL-031). The only Web
 * UI entry point to `src/lib/video-details/`'s real, non-dry-run YouTube write -- title/
 * description/tags/category/privacy always visible, everything else behind "Show more" (matches
 * Studio's own basic/advanced split). "Save to YouTube" is disabled until a preview has been run
 * for the EXACT current patch (patchesEqual) -- editing anything after a preview invalidates it,
 * so the operator can never save a diff they didn't actually see (AGENTS.md §G's "approval").
 */
export function VideoDetailsPanel({
  channelId,
  videoId,
  onDirtyChange,
}: {
  channelId: string;
  videoId: string;
  /** Called whenever "does the form differ from the loaded snapshot" changes -- lets a caller
   * embedding this panel (e.g. inside `video-detail-modal.tsx`) warn before discarding unsaved
   * edits, without this panel needing to know anything about where/how it's displayed. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<VideoDetailsSnapshot | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [previewedPatch, setPreviewedPatch] = useState<Patch | null>(null);
  const [diff, setDiff] = useState<Array<{ field: string; before: unknown; proposed: unknown }> | null>(null);

  const [applying, setApplying] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/videos/${encodeURIComponent(videoId)}/details`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setSnapshot(data);
      setForm(toFormValues(data));
      setPreviewedPatch(null);
      setDiff(null);
      setApplySuccess(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [channelId, videoId]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateForm(patch: Partial<FormValues>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setPreviewedPatch(null);
    setDiff(null);
    setApplySuccess(false);
  }

  const currentPatch = form && snapshot ? buildPatch(form, snapshot) : {};
  const hasChanges = Object.keys(currentPatch).length > 0;
  const canSave = hasChanges && patchesEqual(previewedPatch, currentPatch) && !applying;

  useEffect(() => {
    onDirtyChange?.(hasChanges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges]);

  async function handlePreview() {
    if (!snapshot || !hasChanges) return;
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/videos/${encodeURIComponent(videoId)}/details/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: currentPatch }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setDiff(data.diff);
      setPreviewedPatch(currentPatch);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleApply() {
    if (!snapshot || !canSave) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/videos/${encodeURIComponent(videoId)}/details/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: currentPatch, expectedEtag: snapshot.etag ?? undefined }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setSnapshot(data.after);
      setForm(toFormValues(data.after));
      setPreviewedPatch(null);
      setDiff(null);
      setApplySuccess(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return <p className="text-sm text-zinc-500">Loading details...</p>;
  if (!form || !snapshot) return <p className="text-sm text-red-400">Failed to load video details.</p>;

  const canSetPublishAt = snapshot.privacyStatus === "private" && !snapshot.publishAt;

  return (
    <div className="flex h-full min-h-0 flex-col space-y-4">
      {error && (
        <div className="shrink-0 rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>
      )}
      {applySuccess && (
        <div className="shrink-0 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300">
          Saved to YouTube.
        </div>
      )}

      <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-xs text-zinc-400">Title</span>
          <input
            value={form.title}
            onChange={(e) => updateForm({ title: e.target.value })}
            maxLength={100}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          />
        </label>
        <label className="block">
          <span className="text-xs text-zinc-400">Privacy</span>
          <select
            value={form.privacyStatus}
            onChange={(e) => updateForm({ privacyStatus: e.target.value })}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-zinc-400">Category ID</span>
          <input
            value={form.categoryId}
            onChange={(e) => updateForm({ categoryId: e.target.value })}
            placeholder="e.g. 10 (Music)"
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          />
        </label>
      </div>

      {/* Grows to fill whatever vertical space the rest of the panel doesn't need (owner
       * instruction, 2026-09-21: "описание на весь оставшийся объём экрана по высоте"), with its
       * own internal scrollbar once its own text exceeds that space -- `min-h-0` is required for
       * a flex child to be allowed to shrink below its content's natural height at all, which is
       * what lets the textarea's own `overflow-y-auto` take over instead of growing the panel. */}
      <label className="flex min-h-[140px] flex-1 flex-col">
        <span className="shrink-0 text-xs text-zinc-400">Description</span>
        <textarea
          value={form.description}
          onChange={(e) => updateForm({ description: e.target.value })}
          className="mt-1 w-full flex-1 resize-none overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
        />
      </label>

      <label className="block shrink-0">
        <span className="text-xs text-zinc-400">Tags (comma-separated)</span>
        <textarea
          value={form.tagsText}
          onChange={(e) => updateForm({ tagsText: e.target.value })}
          rows={3}
          className="mt-1 w-full resize-none overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
        />
      </label>

      <button
        onClick={() => setShowMore((v) => !v)}
        className="shrink-0 text-xs font-medium text-zinc-400 hover:text-zinc-200"
      >
        {showMore ? "Hide advanced fields" : "Show more"}
      </button>

      {showMore && (
        <div className="grid shrink-0 grid-cols-1 gap-3 rounded-lg border border-zinc-800 p-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-zinc-400">Default language (BCP-47)</span>
            <input
              value={form.defaultLanguage}
              onChange={(e) => updateForm({ defaultLanguage: e.target.value })}
              placeholder="e.g. en"
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Recording date</span>
            <input
              type="date"
              value={form.recordingDate ? form.recordingDate.slice(0, 10) : ""}
              onChange={(e) => updateForm({ recordingDate: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          {canSetPublishAt && (
            <label className="block">
              <span className="text-xs text-zinc-400">Scheduled publish time (private only, one-time)</span>
              <input
                type="datetime-local"
                value={form.publishAt ? form.publishAt.slice(0, 16) : ""}
                onChange={(e) => updateForm({ publishAt: e.target.value })}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-zinc-400">License</span>
            <select
              value={form.license}
              onChange={(e) => updateForm({ license: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            >
              <option value="youtube">Standard YouTube License</option>
              <option value="creativeCommon">Creative Commons</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={form.embeddable}
              onChange={(e) => updateForm({ embeddable: e.target.checked })}
            />
            Allow embedding
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={form.publicStatsViewable}
              onChange={(e) => updateForm({ publicStatsViewable: e.target.checked })}
            />
            Public stats viewable
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={form.selfDeclaredMadeForKids}
              onChange={(e) => updateForm({ selfDeclaredMadeForKids: e.target.checked })}
            />
            Made for kids
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={form.containsSyntheticMedia}
              onChange={(e) => updateForm({ containsSyntheticMedia: e.target.checked })}
            />
            Contains altered or synthetic (AI) content
          </label>
        </div>
      )}

      {diff && diff.length > 0 && (
        <div className="shrink-0 space-y-2 overflow-y-auto rounded-lg border border-indigo-900/60 bg-indigo-950/20 p-3">
          <p className="text-xs font-semibold text-indigo-300">Preview diff</p>
          {diff.map((d) => (
            <div key={d.field} className="text-xs">
              <span className="font-mono text-zinc-400">{d.field}</span>
              <div className="mt-0.5 grid grid-cols-2 gap-2">
                <p className="truncate text-zinc-500">before: {JSON.stringify(d.before)}</p>
                <p className="truncate text-zinc-200">proposed: {JSON.stringify(d.proposed)}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          onClick={handlePreview}
          disabled={!hasChanges || previewing}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
        >
          {previewing ? "Previewing..." : "Preview changes"}
        </button>
        <button
          onClick={handleApply}
          disabled={!canSave}
          title={hasChanges && !patchesEqual(previewedPatch, currentPatch) ? "Preview again before saving" : undefined}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {applying ? "Saving..." : "Save to YouTube"}
        </button>
        {hasChanges && !patchesEqual(previewedPatch, currentPatch) && (
          <span className="text-xs text-amber-400">Preview again before saving -- the patch changed.</span>
        )}
      </div>
    </div>
  );
}
