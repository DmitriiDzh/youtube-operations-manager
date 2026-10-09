"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";
import { errorText } from "@/lib/ui-text";

const MIN_MONTHS = 1;
const MAX_MONTHS = 60;

/** A whole number of months in 1–60, or null (mirrors `inactivitySettingInputSchema`). */
export function parseInactivityMonthsDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_MONTHS && value <= MAX_MONTHS ? value : null;
}

/**
 * Settings-tab card (BL-163, FO-REQ-0014 §A2): "inactive after N months without uploads", default 6. An inactive watchlist entry is
 * paused and gets a system proposal to delete it (WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.A). One global value, like the watchlist.
 */
export function MarketIntelligenceInactivitySettings() {
  const t = useT();
  const [stored, setStored] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const apply = useCallback((months: number) => {
    setStored(months);
    setDraft(String(months));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market-intelligence/inactivity");
      if (!res.ok) {
        setLoadError(t("settingsCards.inactivity.loadFailed"));
        return;
      }
      setLoadError(null);
      apply(((await res.json()) as { inactiveAfterMonths: number }).inactiveAfterMonths);
    } catch {
      setLoadError(t("settingsCards.inactivity.loadFailed"));
    }
  }, [apply, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = parseInactivityMonthsDraft(draft);
  const dirty = stored !== null && parsed !== null && parsed !== stored;

  async function handleSave() {
    if (parsed === null) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/market-intelligence/inactivity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inactiveAfterMonths: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("settings.saveFailed"), { showErrorField: false }));
        return;
      }
      apply((data as { inactiveAfterMonths: number }).inactiveAfterMonths);
      setSavedNotice(t("common.saved"));
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (stored === null) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
            <button onClick={() => void load()} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("settingsCard.competitorInactivity")}
        <InfoTooltip>{t("settingsCards.inactivity.info")}</InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-zinc-400">{t("settingsCards.inactivity.months")}</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            className="mt-1 block w-28 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
          />
        </label>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      {parsed === null && <p className="text-xs text-amber-400">{t("settingsCards.inactivity.invalid")}</p>}
      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}
    </div>
  );
}
