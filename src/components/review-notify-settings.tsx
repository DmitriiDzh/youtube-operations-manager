"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-248 (ADR 0066, docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md §8): Settings → AI agent → «Будить Продюсера». This computer's switch
// (never set: on when the workspace's 00 YT Producer folder is here) and the Producer's Inbox folder (empty: the default under the
// workspace root), with what the writer last did. Reads and saves only `/api/review-notify`; its own error boundary (AGENTS.md §M).

type View = {
  enabled: boolean;
  enabledSetting: boolean | null;
  defaultEnabled: boolean;
  inboxPath: string | null;
  inboxPathSetting: string | null;
  defaultInboxPath: string | null;
  inboxExists: boolean;
  activeSince: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastWrittenAt: string | null;
  writtenCount: number;
};
type Draft = { enabled: boolean | null; inboxPath: string };

const ROUTE = "/api/review-notify";
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";

const draftOf = (view: View): Draft => ({ enabled: view.enabledSetting, inboxPath: view.inboxPathSetting ?? "" });

export function ReviewNotifySettings() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(ROUTE);
    const body = (await res.json().catch(() => null)) as View | null;
    if (!res.ok || !body) {
      setError(errorText(t, body, t("settings.loadFailed"), { showErrorField: false }));
      return;
    }
    setView(body);
    setDraft((current) => current ?? draftOf(body));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(ROUTE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: draft.enabled, inboxPath: draft.inboxPath.trim() === "" ? null : draft.inboxPath.trim() }),
      });
      const body = (await res.json().catch(() => null)) as View | null;
      if (!res.ok || !body) {
        setError(errorText(t, body, t("common.errorStatus", { status: String(res.status) })));
        return;
      }
      setView(body);
      setDraft(draftOf(body));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!view || !draft) return error ? <p className="text-sm text-amber-400">{error}</p> : null;
  const saved = draftOf(view);
  const dirty = draft.enabled !== saved.enabled || draft.inboxPath.trim() !== saved.inboxPath;
  const shownEnabled = draft.enabled ?? view.defaultEnabled;
  const at = (iso: string | null) => (iso ? formatDisplayDateTime(new Date(iso)) : t("common.never"));

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("settingsCards.reviewNotify.title")}
          <InfoTooltip>{t("settingsCards.reviewNotify.info")}</InfoTooltip>
        </h3>
        <div className="flex items-center gap-2">
          <ToggleSwitch label={t("settingsCards.reviewNotify.toggle")} checked={shownEnabled} onChange={(checked) => setDraft({ ...draft, enabled: checked })} />
          <span className="text-sm text-zinc-300">{t("settingsCards.reviewNotify.toggle")}</span>
        </div>
        {draft.enabled === null ? (
          <p className="text-xs text-zinc-500">{t(view.defaultEnabled ? "settingsCards.reviewNotify.defaultOn" : "settingsCards.reviewNotify.defaultOff")}</p>
        ) : (
          <button type="button" onClick={() => setDraft({ ...draft, enabled: null })} className="text-xs text-zinc-500 hover:text-zinc-300">
            {t("settingsCards.reviewNotify.useDefault")}
          </button>
        )}
        <p className="text-xs text-amber-300/80">{t("settingsCards.reviewNotify.oneComputer")}</p>
      </div>

      <div className="space-y-1">
        <label htmlFor="review-notify-inbox" className="text-sm text-zinc-300">
          {t("settingsCards.reviewNotify.inboxPath")}
        </label>
        <input
          id="review-notify-inbox"
          type="text"
          className={inputClass}
          value={draft.inboxPath}
          placeholder={view.defaultInboxPath ?? ""}
          onChange={(e) => setDraft({ ...draft, inboxPath: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
        <p className="text-xs text-zinc-500">
          {view.defaultInboxPath ? t("settingsCards.reviewNotify.inboxPathHint", { path: view.defaultInboxPath }) : t("settingsCards.reviewNotify.inboxPathNoDefault")}
        </p>
      </div>

      <div className="space-y-1 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        {view.inboxPath && <p className={view.inboxExists ? "text-zinc-400" : "text-amber-400"}>{t(view.inboxExists ? "settingsCards.reviewNotify.inboxOk" : "settingsCards.reviewNotify.inboxMissing")}</p>}
        <p>{t("settingsCards.reviewNotify.lastTick", { at: at(view.lastTickAt) })}</p>
        {view.lastFile && <p className="break-all">{t("settingsCards.reviewNotify.lastFile", { file: view.lastFile, at: at(view.lastWrittenAt) })}</p>}
        <p>{t("settingsCards.reviewNotify.written", { count: String(view.writtenCount) })}</p>
        {view.lastError && <p className="break-all text-amber-400">{t("settingsCards.reviewNotify.lastError", { error: view.lastError })}</p>}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("settingsCards.saveApply")}
        </button>
        {dirty && (
          <button onClick={() => setDraft(saved)} className="text-xs text-zinc-500 hover:text-zinc-300">
            {t("settingsCards.discardChanges")}
          </button>
        )}
      </div>
    </div>
  );
}
