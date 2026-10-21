"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
// The pure file (no server code): the same validator, limits and preview the server uses.
import {
  CHANNEL_DESCRIPTION_MAX_CHARACTERS,
  CHANNEL_LOCALIZATIONS_MAX_LANGUAGES,
  CHANNEL_TITLE_MAX_CHARACTERS,
  validateChannelLocalizations,
  type ChannelLocalizationRefusal,
  type ChannelLocalizationsPreviewProblem,
} from "@/lib/channel-localizations/set";
import type { ChannelLocalizationsLastApply, ChannelLocalizationsPreviewView, ChannelLocalizationsView } from "@/lib/channel-localizations/contracts";
import { ActionButton, StatusNotice } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { checkRows, languageChoices, refusalsByRow, rowsOf, sameAsSaved, setOf, type RowRefusal, type TranslationRow } from "./live-stream-localizations-model";
import { useT } from "./ui-text-provider";

// BL-210 (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md §4/§6, ADR 0047): «Переводы канала» -- the channel's own name and
// description in other languages. Edited and saved on this computer (the Operator may save a set too); «Проверить» reads the channel
// on YouTube and shows what «Применить» would do; «Применить» (after a confirmation dialog) is the only way the set reaches YouTube.
// Placed under the channel's language settings, whose base language is the channel's own text.

const cardClass = "space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const warnClass = "rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200";

const PROBLEM_KEYS: Record<ChannelLocalizationsPreviewProblem, UiTextKey> = {
  default_language_not_set: "channelTranslations.problem.default_language_not_set",
  default_language_mismatch: "channelTranslations.problem.default_language_mismatch",
  own_language_in_live: "channelTranslations.problem.own_language_in_live",
  own_language_in_set: "channelTranslations.problem.own_language_in_set",
  empty_set: "channelTranslations.problem.empty_set",
};

const STATUS_KEYS: Record<"new" | "changed" | "unchanged", UiTextKey> = {
  new: "channelTranslations.status.new",
  changed: "channelTranslations.status.changed",
  unchanged: "channelTranslations.status.unchanged",
};

function refusalText(t: ReturnType<typeof useT>, refusal: RowRefusal): string {
  if (refusal.reason === "unsupported_language" && refusal.hint) return t("channelTranslations.reason.unsupported_languageHint", { hint: refusal.hint });
  const max = refusal.reason === "title_too_long" ? String(CHANNEL_TITLE_MAX_CHARACTERS) : String(CHANNEL_DESCRIPTION_MAX_CHARACTERS);
  return t(`channelTranslations.reason.${refusal.reason}` as UiTextKey, { max });
}

let rowCounter = 0;
const newRowId = () => `channel-row-${++rowCounter}`;
const characters = (value: string) => [...value].length;

export function ChannelLocalizationsPanel({ channelId }: { channelId: string }) {
  const t = useT();
  const base = `/api/channels/${encodeURIComponent(channelId)}/channel-localizations`;
  const [view, setView] = useState<ChannelLocalizationsView | null>(null);
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [serverRefusals, setServerRefusals] = useState<Map<string, RowRefusal[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const [savedSignal, setSavedSignal] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ChannelLocalizationsPreviewView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saved = view?.localizations ?? null;
  const savedKey = JSON.stringify(saved);
  const dirty = !sameAsSaved(rows, saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const rowCountRef = useRef(rows.length);
  rowCountRef.current = rows.length;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelTranslations.loadFailed")));
      setView(body as ChannelLocalizationsView);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelTranslations.loadFailed"));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // A newly saved set (this card's save, or the Operator's) replaces the rows only while the owner has no unsaved edit.
  useEffect(() => {
    // The first load (no rows yet) always fills the card.
    if (dirtyRef.current && rowCountRef.current > 0) return;
    setRows(rowsOf(JSON.parse(savedKey) as ChannelLocalizationsView["localizations"], newRowId));
  }, [savedKey]);

  const baseline = view?.baselineLanguage ?? null;
  const check = useMemo(() => checkRows(rows, baseline, validateChannelLocalizations), [rows, baseline]);
  const valid = check.byRow.size === 0 && !check.tooMany;

  function update(id: string, change: Partial<TranslationRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
    setPreview(null);
    setServerRefusals((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const sent = setOf(rows);
      const response = await fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ localizations: sent }) });
      const body = (await response.json().catch(() => null)) as { details?: { refused?: ChannelLocalizationRefusal[] } } | null;
      if (!response.ok) {
        const refused = body?.details?.refused ?? [];
        if (refused.length > 0) {
          setServerRefusals(refusalsByRow(rows, refused));
          setError(t("channelTranslations.refused"));
        } else {
          setError(errorText(t, body, t("channelTranslations.saveFailed"), { showErrorField: false }));
        }
        return;
      }
      setServerRefusals(new Map());
      setNotice(Object.keys(sent).length > 0 ? t("channelTranslations.saved") : t("channelTranslations.cleared"));
      setSavedSignal((n) => n + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelTranslations.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${base}/preview`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelTranslations.previewFailed")));
      setPreview(body as ChannelLocalizationsPreviewView);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : t("channelTranslations.previewFailed"));
    } finally {
      setPreviewing(false);
    }
  }

  async function apply() {
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      // Review #2: the apply is bound to the set this preview was computed from.
      const response = await fetch(`${base}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setVersion: preview?.setVersion ?? "" }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelTranslations.applyFailed")));
      const result = body as ChannelLocalizationsLastApply;
      if (result.ok) setNotice(result.writes === 0 ? t("channelTranslations.appliedNothing") : t("channelTranslations.applied", { languages: result.languages.join(", ") || "—" }));
      else setError(t("channelTranslations.last.mismatch", { at: new Date(result.at).toLocaleString(t.language), detail: result.detail }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelTranslations.applyFailed"));
    } finally {
      setApplying(false);
      setConfirming(false);
      setPreview(null);
      await load();
    }
  }

  const last = view?.lastApply ?? null;
  const lastAt = last ? new Date(last.at).toLocaleString(t.language) : "";
  const canApply = preview !== null && preview.problems.length === 0 && preview.quota.writes > 0 && !dirty && !applying;
  const busy = saving || previewing || applying;

  return (
    <div className={cardClass}>
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("channelTranslations.title")}
          <InfoTooltip>{t("channelTranslations.info")}</InfoTooltip>
        </h3>
        <p className="mt-1 text-xs text-zinc-400">{baseline ? t("channelTranslations.intro", { language: baseline }) : t("channelTranslations.introNoBaseline")}</p>
      </div>
      {view?.problem && <p className={warnClass}>{t("channelTranslations.problem", { problem: view.problem })}</p>}
      {last &&
        (last.ok ? (
          <p className="text-xs text-emerald-300">
            {last.writes === 0 ? t("channelTranslations.last.nothing", { at: lastAt }) : t("channelTranslations.last.ok", { at: lastAt, languages: last.languages.join(", ") || "—" })}
          </p>
        ) : last.failure === "read_back_mismatch" ? (
          <p className="text-xs text-amber-300">{t("channelTranslations.last.mismatch", { at: lastAt, detail: last.detail })}</p>
        ) : (
          <p className="text-xs text-amber-300">{t("channelTranslations.last.failed", { at: lastAt, error: last.error ?? last.detail })}</p>
        ))}
      {rows.length === 0 && <p className="text-sm text-zinc-500">{t("channelTranslations.empty")}</p>}
      <ul className="space-y-3">
        {rows.map((row) => {
          const refusals = [...(check.byRow.get(row.id) ?? []), ...(serverRefusals.get(row.id) ?? [])];
          const unique = refusals.filter((r, i) => refusals.findIndex((o) => o.reason === r.reason) === i);
          const titleLength = characters(row.title.trim());
          const descriptionLength = characters(row.description.replace(/\r\n/g, "\n"));
          const choices = languageChoices(rows, row.id, baseline);
          return (
            <li key={row.id} className="space-y-2 rounded-lg border border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-zinc-400">
                  <span>{t("channelTranslations.language")}</span>
                  <select value={row.language} onChange={(e) => update(row.id, { language: e.target.value })} disabled={busy} className={`${inputClass} max-w-64`}>
                    <option value="">{t("channelTranslations.chooseLanguage")}</option>
                    {/* A stored language the list no longer offers stays visible (never dropped silently). */}
                    {row.language && !choices.some((l) => l.code === row.language) && <option value={row.language}>{row.language}</option>}
                    {choices.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {/* ui-text-ignore: the language's code and YouTube's own name for it (data) */}
                        {`${lang.code} — ${lang.name}`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setRows((current) => current.filter((r) => r.id !== row.id));
                    setPreview(null);
                  }}
                  disabled={busy}
                  className={`${buttonClass} ml-auto`}
                >
                  {t("channelTranslations.remove")}
                </button>
              </div>
              <label className="block space-y-1 text-sm text-zinc-400">
                <span>{t("channelTranslations.fieldTitle")}</span>
                <input type="text" value={row.title} onChange={(e) => update(row.id, { title: e.target.value })} disabled={busy} className={`${inputClass} w-full`} />
                <span className={`block text-[11px] ${titleLength > CHANNEL_TITLE_MAX_CHARACTERS ? "text-amber-300" : "text-zinc-500"}`}>
                  {t("channelTranslations.count", { count: String(titleLength), max: String(CHANNEL_TITLE_MAX_CHARACTERS) })}
                </span>
              </label>
              <label className="block space-y-1 text-sm text-zinc-400">
                <span>{t("channelTranslations.fieldDescription")}</span>
                <textarea value={row.description} rows={4} onChange={(e) => update(row.id, { description: e.target.value })} disabled={busy} className={`${inputClass} w-full`} />
                <span className={`block text-[11px] ${descriptionLength > CHANNEL_DESCRIPTION_MAX_CHARACTERS ? "text-amber-300" : "text-zinc-500"}`}>
                  {t("channelTranslations.count", { count: String(descriptionLength), max: String(CHANNEL_DESCRIPTION_MAX_CHARACTERS) })}
                </span>
              </label>
              {unique.length > 0 && (
                <ul className="space-y-0.5 text-xs text-amber-300">
                  {unique.map((refusal) => (
                    <li key={refusal.reason}>{refusalText(t, refusal)}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {check.tooMany && <p className="text-xs text-amber-300">{t("channelTranslations.tooMany", { max: String(CHANNEL_LOCALIZATIONS_MAX_LANGUAGES) })}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setRows((current) => [...current, { id: newRowId(), language: "", title: "", description: "" }]);
            setPreview(null);
          }}
          disabled={busy || rows.length >= CHANNEL_LOCALIZATIONS_MAX_LANGUAGES}
          className={buttonClass}
        >
          {t("channelTranslations.add")}
        </button>
        <ActionButton busy={saving} busyLabel={t("common.saving")} doneSignal={savedSignal} onClick={() => void save()} disabled={busy || !dirty || !valid} className={primaryClass}>
          {t("channelTranslations.save")}
        </ActionButton>
        <ActionButton busy={previewing} busyLabel={t("channelTranslations.previewing")} onClick={() => void runPreview()} disabled={busy || dirty || !saved} className={buttonClass}>
          {t("channelTranslations.preview")}
        </ActionButton>
        <button type="button" onClick={() => setConfirming(true)} disabled={!canApply} className={primaryClass}>
          {t("channelTranslations.apply")}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500">{dirty && saved !== null ? t("channelTranslations.unsavedChanges") : t("channelTranslations.previewHint")}</p>
      {preview && (
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3 text-xs text-zinc-300">
          <ul className="space-y-0.5">
            {preview.languages.map((entry) => (
              <li key={entry.language}>
                {/* ui-text-ignore: a language code (data) */}
                <span className="font-mono">{entry.language}</span> — {t(STATUS_KEYS[entry.status])}
              </li>
            ))}
          </ul>
          <p>{preview.untouched.length > 0 ? t("channelTranslations.untouched", { languages: preview.untouched.join(", ") }) : t("channelTranslations.untouchedNone")}</p>
          {preview.defaultLanguage.current && <p>{t("channelTranslations.defaultLanguageCurrent", { language: preview.defaultLanguage.current })}</p>}
          {preview.problems.map((problem) => (
            <p key={problem} className={warnClass}>
              {t(PROBLEM_KEYS[problem])}
            </p>
          ))}
          {preview.problems.length === 0 &&
            (preview.quota.writes === 0 ? (
              <p>{t("channelTranslations.nothingToWrite")}</p>
            ) : (
              <p>{t("channelTranslations.quota", { units: String(preview.quota.writeUnits), writes: String(preview.quota.writes), reads: String(preview.quota.readUnits) })}</p>
            ))}
        </div>
      )}
      {(saving || previewing || applying) && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
      {confirming && preview && (
        <ConfirmDialog
          title={t("channelTranslations.confirmTitle")}
          description={t("channelTranslations.confirmBody", { count: String(preview.languages.filter((l) => l.status !== "unchanged").length) })}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("channelTranslations.confirm")}
          confirmBusyLabel={applying ? t("channelTranslations.applying") : null}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      )}
    </div>
  );
}
