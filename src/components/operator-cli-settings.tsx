"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.5, AC-P12-10) -- "Operator CLI access":
 * whether the CLI may run at all, as the operator (the agent mode was removed, ADR 0013). Off by default and persistent.
 * While it is off, a shell-capable agent cannot bypass its channel binding by simply omitting its
 * token. Same fetch/save shape as `mcp-connection-settings.tsx` (`/api/settings` applies only the
 * fields present in a POST body).
 */
export function OperatorCliSettings() {
  const t = useT();
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as { operatorCliEnabled: boolean };
    if (ownSettingsUnavailable(data, ["operatorCliEnabled"])) return;
    setSaved(data.operatorCliEnabled);
    setDraft(data.operatorCliEnabled);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorCliEnabled: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? t("common.errorStatus", { status: String(res.status) }));
        return;
      }
      setSaved(data.operatorCliEnabled);
      setDraft(data.operatorCliEnabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (draft === null) return null;
  const dirty = draft !== saved;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("settingsCards.operatorCli.title")}
          <InfoTooltip>{t("settingsCards.operatorCli.info")}</InfoTooltip>
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch
            label={t("settingsCards.operatorCli.toggle")}
            checked={draft}
            onChange={(checked) => (checked ? setConfirming(true) : setDraft(false))}
          />
          <span className="text-sm text-zinc-300">{t("settingsCards.operatorCli.toggle")}</span>
        </div>
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

      {confirming && (
        <ConfirmDialog
          title={t("settingsCards.operatorCli.confirmTitle")}
          description={t("settingsCards.operatorCli.confirmBody")}
          confirmLabel={t("settingsCards.operatorCli.confirmAllow")}
          confirmVariant="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setDraft(true);
          }}
        />
      )}
    </div>
  );
}
