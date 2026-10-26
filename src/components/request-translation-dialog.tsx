"use client";

import { errorText } from "@/lib/ui-text";
import { useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import { useT } from "./ui-text-provider";

// BL-227 stage 2 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §7a, FO-MSG-0025 §1): the owner asks the channel's agent for translations
// of one or more videos, or for a redo of one language. The request is only stored; the agent claims it and makes the change sets,
// which then wait for the owner's review like any other.

export function RequestTranslationDialog({
  channelId,
  videoIds,
  languages,
  defaultLanguages,
  redo,
  onClose,
  onCreated,
}: {
  channelId: string;
  videoIds: string[];
  /** The languages offered (the channel's languages). */
  languages: string[];
  /** Ticked at the start (the languages the videos lack, or the one to redo). */
  defaultLanguages: string[];
  /** A redo of one language from the review screen: the rejected change it replaces. */
  redo?: { changeId: string };
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>(defaultLanguages);
  const [mode, setMode] = useState<"fill_missing" | "redo">(redo ? "redo" : "fill_missing");
  const [fields, setFields] = useState<"both" | "title" | "description">("both");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/localization-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds, languages: picked, mode, fields, ...(note.trim() ? { note: note.trim() } : {}), ...(redo ? { redoOfChangeId: redo.changeId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const choices = [...new Set([...languages, ...defaultLanguages])];
  return (
    <BlockingDialog label={t("langRequest.title")} busy={busy}>
      <p className="text-sm font-medium text-zinc-100">{redo ? t("langRequest.redoTitle") : t("langRequest.titleCount", { count: videoIds.length })}</p>
      <p className="text-xs text-zinc-400">{t("langRequest.explain")}</p>
      <div>
        <p className="mb-1 text-xs text-zinc-400">{t("langRequest.languages")}</p>
        <div className="flex flex-wrap gap-2">
          {choices.map((language) => (
            <label key={language} className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200">
              <input
                type="checkbox"
                checked={picked.includes(language)}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, language] : prev.filter((l) => l !== language)))}
              />
              {language}
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "fill_missing"} onChange={() => setMode("fill_missing")} />
          {t("langRequest.modeFill")}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "redo"} onChange={() => setMode("redo")} />
          {t("langRequest.modeRedo")}
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
        {(["both", "title", "description"] as const).map((value) => (
          <label key={value} className="flex items-center gap-1">
            <input type="radio" checked={fields === value} onChange={() => setFields(value)} />
            {t(`langRequest.fields.${value}`)}
          </label>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder={t("langRequest.notePlaceholder")}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500">
          {t("langRequest.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || picked.length === 0}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {t("langRequest.submit")}
        </button>
      </div>
    </BlockingDialog>
  );
}
