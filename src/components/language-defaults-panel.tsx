"use client";

import { useCallback, useEffect, useState } from "react";

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

/**
 * Per-channel expected language baseline (owner instruction 2026-10-02): "Title and description
 * language" (`defaultLanguage`) and "Video language" (`defaultAudioLanguage`). This panel only
 * stores the expectation and lists videos that deviate from it -- it never writes to YouTube.
 * Aligning `defaultLanguage` through the API is a separate, approval-gated step; `defaultAudioLanguage`
 * is not settable via the public API, so deviations in it are informational ("fix in Studio").
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
      {open && deviations.length > 0 && (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="px-3 py-1.5">Video</th>
                <th className="px-3 py-1.5">Title/description language</th>
                <th className="px-3 py-1.5">Video language</th>
              </tr>
            </thead>
            <tbody>
              {deviations.map((row) => (
                <tr key={row.videoId} className="border-t border-zinc-800">
                  <td className="px-3 py-1.5">{row.title}</td>
                  <td className={`px-3 py-1.5 ${row.defaultLanguageDeviates ? "text-amber-400" : "text-zinc-400"}`}>
                    {row.defaultLanguage ?? "not set"}
                  </td>
                  <td className={`px-3 py-1.5 ${row.defaultAudioLanguageDeviates ? "text-amber-400" : "text-zinc-400"}`}>
                    {row.defaultAudioLanguage ?? "not set"}
                    {row.defaultAudioLanguageDeviates && <span className="ml-1 text-zinc-500">(change in Studio)</span>}
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
