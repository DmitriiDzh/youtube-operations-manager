"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

type LanguageOption = { code: string; name: string };

type DeviationRow = {
  videoId: string;
  title: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  defaultLanguageDeviates: boolean;
  defaultAudioLanguageDeviates: boolean;
};

type Report = {
  defaults: { defaultLanguage: string | null; defaultAudioLanguage: string | null };
  totalVideos: number;
  deviations: DeviationRow[];
};

const NOT_APPLICABLE = "zxx";

type AlignState =
  | { status: "ready"; etag: string | null; before: string | null }
  | { status: "applied" }
  | { status: "failed"; message: string };

/**
 * Per-channel expected language baseline (owner instruction 2026-10-02): "Title and description
 * language" (`defaultLanguage`) and "Video language" (`defaultAudioLanguage`). This panel only
 * stores the expectation and lists videos that deviate from it; writing happens only through the
 * approval-gated "Fix all"/Preview + Confirm flow over `video-details`. `defaultAudioLanguage` is not in
 * the official `videos.update` settable list, so writing it is experimental (owner 2026-10-02) -- the
 * read-back check reports a failure if YouTube ignores or rejects it.
 */
export function LanguageDefaultsPanel({
  channelId,
  supportedLanguages,
}: {
  channelId: string;
  supportedLanguages: LanguageOption[];
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [language, setLanguage] = useState("");
  const [audio, setAudio] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [align, setAlign] = useState<Record<string, AlignState>>({});
  const [aligning, setAligning] = useState<"preview" | "apply" | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/language-defaults`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Failed to load language defaults");
      setReport(data);
      setLanguage(data.defaults.defaultLanguage ?? "");
      setAudio(data.defaults.defaultAudioLanguage ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load language defaults");
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/language-defaults`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultLanguage: language || null, defaultAudioLanguage: audio || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Failed to save");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  const target = report?.defaults.defaultLanguage ?? null;
  const targetAudio = report?.defaults.defaultAudioLanguage ?? null;
  const fixable = deviations_of(report).filter((row) => row.defaultLanguageDeviates || row.defaultAudioLanguageDeviates);
  /** Only the fields that actually deviate for this video -- an in-sync field is never re-sent. */
  const patchFor = (row: DeviationRow) => ({
    ...(row.defaultLanguageDeviates && target ? { defaultLanguage: target } : {}),
    ...(row.defaultAudioLanguageDeviates && targetAudio ? { defaultAudioLanguage: targetAudio } : {}),
  });
  const chosen = fixable.filter((row) => selected.has(row.videoId));
  const readyIds = chosen.filter((row) => align[row.videoId]?.status === "ready").map((row) => row.videoId);

  function toggle(videoId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
    setAlign((prev) => {
      const next = { ...prev };
      delete next[videoId];
      return next;
    });
  }

  const detailsUrl = (videoId: string, step: "preview" | "apply") =>
    `/api/channels/${encodeURIComponent(channelId)}/videos/${encodeURIComponent(videoId)}/details/${step}`;

  async function previewAlignment(rows: DeviationRow[] = chosen): Promise<Record<string, AlignState>> {
    const next: Record<string, AlignState> = {};
    if (!target && !targetAudio) return next;
    setAligning("preview");
    let done = 0;
    for (const row of rows) {
      setProgress(`Checking ${++done} / ${rows.length}...`);
      try {
        const res = await fetch(detailsUrl(row.videoId, "preview"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: patchFor(rows.find((r) => r.videoId === row.videoId) ?? row) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message ?? data.error ?? "Preview failed");
        next[row.videoId] = { status: "ready", etag: data.before?.etag ?? null, before: data.before?.defaultLanguage ?? null };
      } catch (e) {
        next[row.videoId] = { status: "failed", message: e instanceof Error ? e.message : "Preview failed" };
      }
    }
    setAlign((prev) => ({ ...prev, ...next }));
    setAligning(null);
    setProgress(null);
    return next;
  }

  /** One-button flow: preview EVERY video that deviates (read-only), then ask once before writing. */
  async function fixAll() {
    if (!target && !targetAudio) return;
    setSelected(new Set(fixable.map((row) => row.videoId)));
    setOpen(true);
    const next = await previewAlignment(fixable);
    if (Object.values(next).some((state) => state.status === "ready")) setConfirmAll(true);
  }

  /** Sequential and fail-fast: the first failure stops the run, so a systemic problem (live writes
   * off, wrong channel, quota) is reported once instead of repeated for every selected video. */
  async function applyAlignment() {
    if (!target && !targetAudio) return;
    setAligning("apply");
    let done = 0;
    for (const videoId of readyIds) {
      setProgress(`Writing ${++done} / ${readyIds.length}...`);
      const state = align[videoId];
      if (state?.status !== "ready") continue;
      try {
        const res = await fetch(detailsUrl(videoId, "apply"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: patchFor(chosen.find((r) => r.videoId === videoId)!), ...(state.etag ? { expectedEtag: state.etag } : {}) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message ?? data.error ?? "Apply failed");
        if (data.verified === false) throw new Error("Written, but the read-back did not match");
        setAlign((prev) => ({ ...prev, [videoId]: { status: "applied" } }));
      } catch (e) {
        setAlign((prev) => ({ ...prev, [videoId]: { status: "failed", message: e instanceof Error ? e.message : "Apply failed" } }));
        break;
      }
    }
    setAligning(null);
    setProgress(null);
    await load();
  }

  const dirty =
    report !== null &&
    ((report.defaults.defaultLanguage ?? "") !== language || (report.defaults.defaultAudioLanguage ?? "") !== audio);
  const deviations = report?.deviations ?? [];
  const selectClass = "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1">
          <span className="block text-xs text-zinc-400">Title and description language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={selectClass}>
            <option value="">Not set</option>
            {supportedLanguages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-zinc-400">Video language</span>
          <select value={audio} onChange={(e) => setAudio(e.target.value)} className={selectClass}>
            <option value="">Not set</option>
            <option value={NOT_APPLICABLE}>Not applicable ({NOT_APPLICABLE})</option>
            {supportedLanguages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save channel defaults"}
        </button>
        {(target || targetAudio) && fixable.length > 0 && (
          <button
            onClick={fixAll}
            disabled={aligning !== null || dirty}
            title={dirty ? "Save channel defaults first" : undefined}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {aligning === "preview" && progress ? progress : aligning === "apply" && progress ? progress : `Fix all ${fixable.length} videos`}
          </button>
        )}
        {report && (
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={deviations.length === 0}
            className="text-xs text-zinc-400 underline disabled:no-underline disabled:opacity-60"
          >
            {deviations.length === 0
              ? "All videos match the defaults"
              : `${deviations.length} of ${report.totalVideos} videos differ from the defaults`}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {confirmAll && (
        <ConfirmDialog
          title={`Set ${[target && `Title/description language "${target}"`, targetAudio && `Video language "${targetAudio}"`].filter(Boolean).join(" and ")} on ${readyIds.length} videos?`}
          description={`Writes only the language labels to YouTube (title and description text stay unchanged); only fields that differ are sent. Each video is backed up and verified; the run stops at the first error.${
            fixable.length > readyIds.length ? ` ${fixable.length - readyIds.length} video(s) failed the check and will be skipped (see the list).` : ""
          }`}
          confirmLabel={`Write ${readyIds.length} videos to YouTube`}
          confirmVariant="danger"
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void applyAlignment();
          }}
        />
      )}
      {open && deviations.length > 0 && (target || targetAudio) && fixable.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          <span>
            Align language labels to the defaults (title and description text are not changed). Video language is written
            experimentally -- a failure means YouTube refused it.
          </span>
          <button
            onClick={() => void previewAlignment()}
            disabled={aligning !== null || chosen.length === 0}
            className="rounded-lg bg-zinc-700 px-3 py-1 text-white hover:bg-zinc-600 disabled:opacity-50"
          >
            {aligning === "preview" ? "Checking..." : `Preview (${chosen.length})`}
          </button>
          <button
            onClick={applyAlignment}
            disabled={aligning !== null || readyIds.length === 0}
            className="rounded-lg bg-red-600 px-3 py-1 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {aligning === "apply" ? "Writing..." : `Confirm and write to YouTube (${readyIds.length})`}
          </button>
        </div>
      )}
      {open && deviations.length > 0 && (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="px-3 py-1.5" />
                <th className="px-3 py-1.5">Video</th>
                <th className="px-3 py-1.5">Title/description language</th>
                <th className="px-3 py-1.5">Video language</th>
              </tr>
            </thead>
            <tbody>
              {deviations.map((row) => (
                <tr key={row.videoId} className="border-t border-zinc-800">
                  <td className="px-3 py-1.5">
                    {(row.defaultLanguageDeviates || row.defaultAudioLanguageDeviates) && (
                      <input type="checkbox" checked={selected.has(row.videoId)} onChange={() => toggle(row.videoId)} />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {row.title}
                    {align[row.videoId]?.status === "ready" && <span className="ml-2 text-emerald-400">ready</span>}
                    {align[row.videoId]?.status === "applied" && <span className="ml-2 text-emerald-400">written</span>}
                    {align[row.videoId]?.status === "failed" && (
                      <span className="ml-2 text-red-400">{(align[row.videoId] as { message: string }).message}</span>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 ${row.defaultLanguageDeviates ? "text-amber-400" : "text-zinc-400"}`}>
                    {row.defaultLanguage ?? "not set"}
                  </td>
                  <td className={`px-3 py-1.5 ${row.defaultAudioLanguageDeviates ? "text-amber-400" : "text-zinc-400"}`}>
                    {row.defaultAudioLanguage ?? "not set"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function deviations_of(report: Report | null): DeviationRow[] {
  return report?.deviations ?? [];
}
