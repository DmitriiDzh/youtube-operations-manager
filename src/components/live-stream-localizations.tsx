"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { DESCRIPTION_MAX_BYTES, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
// The pure file (no server code): the same validator and limits the server uses.
import { LIVE_LOCALIZATIONS_MAX_LANGUAGES, type LiveLocalizationRefusal, type LiveLocalizationsView } from "@/lib/live-streams/localizations";
import { ActionButton, StatusNotice } from "./busy-feedback";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { checkRows, languageChoices, refusalsByRow, rowsOf, sameAsSaved, setOf, type RowRefusal, type TranslationRow } from "./live-stream-localizations-model";
import { useT } from "./ui-text-provider";

// BL-207 stage 5 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2, ADR 0045): «Переводы» -- the stream's title and description in
// other languages, one set for the whole stream (every broadcast and segment gets it after Start, right after the video's
// details). Saving stays on this computer; the server refuses the whole set if any language fails, and the card shows each
// refusal on its row. Placed right under the title and description it translates.

const cardClass = "space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const warnClass = "rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200";

const WARNING_KEYS: Record<string, UiTextKey> = {
  video_settings_not_saved: "live.translations.warning.videoSettingsNotSaved",
  video_settings_invalid: "live.translations.warning.videoSettingsInvalid",
};

const SKIPPED_KEYS: Record<string, UiTextKey> = {
  fields_failed: "live.translations.skipped.fields_failed",
  stream_stopped: "live.translations.skipped.stream_stopped",
  broadcast_replaced: "live.translations.skipped.broadcast_replaced",
};

function refusalText(t: ReturnType<typeof useT>, refusal: RowRefusal): string {
  if (refusal.reason === "unsupported_language" && refusal.hint) return t("live.translations.reason.unsupported_languageHint", { hint: refusal.hint });
  const max = refusal.reason === "title_too_long" ? String(TITLE_MAX_CHARACTERS) : String(DESCRIPTION_MAX_BYTES);
  return t(`live.translations.reason.${refusal.reason}` as UiTextKey, { max });
}

let rowCounter = 0;
const newRowId = () => `row-${++rowCounter}`;

export function LiveStreamLocalizationsCard({
  base,
  view,
  channelLanguage,
  hasStream,
  onChanged,
}: {
  base: string;
  /** The saved set, its warnings and the last localizations step (null: the server did not send it). */
  view: LiveLocalizationsView | null;
  /** The channel's baseline language: its text is the stream's own title and description (never a translation). */
  channelLanguage: string | null;
  /** Translations belong to a saved stream row (the server refuses them without one). */
  hasStream: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const saved = view?.localizations ?? null;
  const savedKey = JSON.stringify(saved);
  const [rows, setRows] = useState<TranslationRow[]>(() => rowsOf(saved, newRowId));
  const [serverRefusals, setServerRefusals] = useState<Map<string, RowRefusal[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const [savedSignal, setSavedSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A newly saved set (this card's save, or the poll) replaces the rows only while the owner has no unsaved edit.
  const dirty = !sameAsSaved(rows, saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setRows(rowsOf(JSON.parse(savedKey) as LiveLocalizationsView["localizations"], newRowId));
  }, [savedKey]);

  const check = useMemo(() => checkRows(rows, channelLanguage), [rows, channelLanguage]);
  const valid = check.byRow.size === 0 && !check.tooMany;

  function update(id: string, change: Partial<TranslationRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
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
    try {
      const sent = setOf(rows);
      const response = await fetch(`${base}/localizations`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ localizations: sent }) });
      const body = (await response.json().catch(() => null)) as { details?: { refused?: LiveLocalizationRefusal[] } } | null;
      if (!response.ok) {
        const refused = body?.details?.refused ?? [];
        if (refused.length > 0) {
          setServerRefusals(refusalsByRow(rows, refused));
          setError(t("live.translations.refused"));
        } else {
          setError(errorText(t, body, t("settings.saveFailed"), { showErrorField: false }));
        }
        return;
      }
      setServerRefusals(new Map());
      setNotice(Object.keys(sent).length > 0 ? t("live.translations.saved") : t("live.translations.cleared"));
      setSavedSignal((n) => n + 1);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.actionFailed"));
    } finally {
      setSaving(false);
    }
  }

  const last = view?.lastStep ?? null;
  const lastAt = last ? new Date(last.at).toLocaleString(t.language) : "";

  return (
    <div className={cardClass}>
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("live.translations.title")}
          <InfoTooltip>{t("live.translations.info")}</InfoTooltip>
        </h3>
        <p className="mt-1 text-xs text-zinc-400">{channelLanguage ? t("live.translations.intro", { language: channelLanguage }) : t("live.translations.introNoBaseline")}</p>
      </div>
      {!hasStream && <p className="text-xs text-zinc-500">{t("live.translations.noStream")}</p>}
      {view?.problem && <p className={warnClass}>{t("live.translations.problem", { problem: view.problem })}</p>}
      {(view?.warnings ?? []).map((warning) => (
        <p key={warning.code} className={warnClass}>
          {WARNING_KEYS[warning.code] ? t(WARNING_KEYS[warning.code]) : warning.message}
        </p>
      ))}
      {last &&
        (last.ok && !last.skipped ? (
          <p className="text-xs text-emerald-300">{t("live.translations.last.ok", { at: lastAt })}</p>
        ) : last.ok ? (
          <p className="text-xs text-zinc-400">{t("live.translations.last.skipped", { at: lastAt, reason: SKIPPED_KEYS[last.skipped ?? ""] ? t(SKIPPED_KEYS[last.skipped ?? ""]) : (last.skipped ?? "") })}</p>
        ) : (
          <p className="text-xs text-amber-300">{t("live.translations.last.failed", { at: lastAt, error: last.error ?? "—" })}</p>
        ))}
      {rows.length === 0 && <p className="text-sm text-zinc-500">{t("live.translations.empty")}</p>}
      <ul className="space-y-3">
        {rows.map((row) => {
          const refusals = [...(check.byRow.get(row.id) ?? []), ...(serverRefusals.get(row.id) ?? [])];
          const unique = refusals.filter((r, i) => refusals.findIndex((o) => o.reason === r.reason) === i);
          const bytes = new TextEncoder().encode(row.description).length;
          return (
            <li key={row.id} className="space-y-2 rounded-lg border border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-zinc-400">
                  <span>{t("live.translations.language")}</span>
                  <select value={row.language} onChange={(e) => update(row.id, { language: e.target.value })} disabled={saving || !hasStream} className={`${inputClass} max-w-64`}>
                    <option value="">{t("live.translations.chooseLanguage")}</option>
                    {/* A stored language the list no longer offers stays visible (never dropped silently). */}
                    {row.language && !languageChoices(rows, row.id, channelLanguage).some((l) => l.code === row.language) && <option value={row.language}>{row.language}</option>}
                    {languageChoices(rows, row.id, channelLanguage).map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {/* ui-text-ignore: the language's code and YouTube's own name for it (data) */}
                        {`${lang.code} — ${lang.name}`}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))} disabled={saving} className={`${buttonClass} ml-auto`}>
                  {t("live.translations.remove")}
                </button>
              </div>
              <label className="block space-y-1 text-sm text-zinc-400">
                <span>{t("live.field.title")}</span>
                <input type="text" value={row.title} onChange={(e) => update(row.id, { title: e.target.value })} disabled={saving || !hasStream} className={`${inputClass} w-full`} />
              </label>
              <label className="block space-y-1 text-sm text-zinc-400">
                <span>{t("live.field.description")}</span>
                <textarea value={row.description} rows={3} onChange={(e) => update(row.id, { description: e.target.value })} disabled={saving || !hasStream} className={`${inputClass} w-full`} />
                <span className={`block text-[11px] ${bytes > DESCRIPTION_MAX_BYTES ? "text-amber-300" : "text-zinc-500"}`}>{t("live.translations.bytes", { bytes: String(bytes), max: String(DESCRIPTION_MAX_BYTES) })}</span>
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
      {check.tooMany && <p className="text-xs text-amber-300">{t("live.translations.tooMany", { max: String(LIVE_LOCALIZATIONS_MAX_LANGUAGES) })}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setRows((current) => [...current, { id: newRowId(), language: "", title: "", description: "" }])} disabled={saving || !hasStream || rows.length >= LIVE_LOCALIZATIONS_MAX_LANGUAGES} className={buttonClass}>
          {t("live.translations.add")}
        </button>
        <ActionButton busy={saving} busyLabel={t("common.saving")} doneSignal={savedSignal} onClick={() => void save()} disabled={saving || !hasStream || !dirty || !valid} className={primaryClass}>
          {t("live.translations.save")}
        </ActionButton>
      </div>
      {saving && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
    </div>
  );
}
