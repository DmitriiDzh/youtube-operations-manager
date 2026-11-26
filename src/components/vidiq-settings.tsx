"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { ToggleSwitch } from "./toggle-switch";
import { useUiText } from "./ui-text-provider";

// BL-278 (ADR 0077, VIDIQ_INTEGRATION_PLAN.md §5 stage 1): Settings → Cloud APIs → vidIQ. The key (checked with vidIQ's free balance
// read, stored encrypted on this computer, shown only by its last 4 characters; entered on the Mac only), the switch, the connection
// status, «Проверить подключение» (the free drift report of the 18 allowed tools), the balance with «Обновить», the monthly credits
// budget and the 20 newest ledger rows. The card talks only to /api/vidiq; its view types are local (no server code in the bundle).

type DriftState = "ok" | "vidiq_tool_missing" | "vidiq_schema_drift" | "vidiq_cost_changed" | "vidiq_annotation_drift";
type LedgerOutcome = "pending" | "ok" | "cache_hit" | "refused" | "failed" | "unknown" | "job_pending";

type VidiqStatus = {
  key: { state: "set" | "none" | "key_file_missing" | "key_file_invalid"; hint: string | null; status: "ok" | "invalid" | null; verifiedAt: string | null };
  enabled: boolean;
  balance: {
    type: string | null;
    planName: string | null;
    totalCredits: number;
    renewableCredits: number | null;
    maxRenewableCredits: number | null;
    renewableResetsAt: string;
    addOnCredits: number | null;
    readAt: string;
  } | null;
  budget: { monthly: number; spentInPeriod: number; remaining: number; periodStartsAt: string; periodEndsAt: string };
  ledger: Array<{ id: number; at: string; caller: "owner" | "producer"; tool: string; statedCost: number; creditsUsed: number | null; outcome: LedgerOutcome; errorCode: string | null }>;
};

type DriftReport = { readAt: string; report: Array<{ tool: string; state: DriftState }> };

const ROUTE = "/api/vidiq";
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";

export function VidiqSettings() {
  const { t, formatNumber } = useUiText();
  const [status, setStatus] = useState<VidiqStatus | null>(null);
  const [report, setReport] = useState<DriftReport | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${ROUTE}${path}`, init);
      const body = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) throw new Error(errorTextOf(body));
      return body as T;
      function errorTextOf(value: unknown): string {
        const code = (value as { error?: unknown })?.error;
        if (code === "remote_access_mac_only") return t("vidiq.key.macOnly");
        return typeof code === "string" && code.startsWith("vidiq_") ? t(`errors.${code}` as UiTextKey) : t("vidiq.failed");
      }
    },
    [t]
  );

  const apply = useCallback((next: VidiqStatus) => {
    setStatus(next);
    setEditing(next.key.state !== "set");
    setBudget(String(next.budget.monthly));
  }, []);

  useEffect(() => {
    request<VidiqStatus>("")
      .then(apply)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("vidiq.failed")));
  }, [request, apply, t]);

  async function run<T>(action: () => Promise<T>, success: string | null, after?: (value: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const value = await action();
      after?.(value);
      if (success) setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("vidiq.failed"));
    } finally {
      setBusy(false);
    }
  }

  const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const budgetValid = /^\d{1,6}$/.test(budget.trim()) && Number(budget.trim()) <= 100_000;
  const date = (iso: string) => formatDisplayDateTime(iso);

  if (!status) {
    return (
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="text-base font-semibold text-zinc-100">{t("vidiq.title")}</h3>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  const keySet = status.key.state === "set";
  const plan = status.balance?.planName ?? status.balance?.type ?? null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("vidiq.title")}
        <InfoTooltip>{t("vidiq.info")}</InfoTooltip>
      </h3>

      <p className="text-sm text-zinc-300">
        {!keySet
          ? t("vidiq.status.notConfigured")
          : status.key.status === "invalid"
            ? t("vidiq.status.refused")
            : plan
              ? t("vidiq.status.connected", { plan })
              : t("vidiq.status.connectedNoPlan")}
      </p>
      {status.key.state === "key_file_missing" && <p className="text-xs text-amber-400">{t("vidiq.key.fileMissing")}</p>}
      {status.key.state === "key_file_invalid" && <p className="text-xs text-red-400">{t("vidiq.key.fileInvalid")}</p>}

      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={status.enabled}
          disabled={busy || (!keySet && !status.enabled)}
          label={t("vidiq.switch.label")}
          onChange={(next) => void run(() => request<VidiqStatus>("/settings", json("PATCH", { enabled: next })), next ? t("vidiq.switch.on") : t("vidiq.switch.off"), apply)}
        />
        <span className="text-sm text-zinc-200">{t("vidiq.switch.label")}</span>
      </div>

      {keySet && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">{t("vidiq.key.hint", { hint: status.key.hint ?? "····" })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className={secondaryButton}>
              {t("vidiq.key.replace")}
            </button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
              {t("vidiq.key.clear")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t("vidiq.key.field")}
            <MaskedSecretInput name="vidiq-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={inputClass} />
          </label>
          <p className="text-xs text-zinc-500">{t("vidiq.key.where")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || apiKey.trim().length < 8}
              className={primaryButton}
              onClick={() =>
                void run(() => request<VidiqStatus>("/key", json("PUT", { apiKey: apiKey.trim() })), t("vidiq.key.saved"), (next) => {
                  setApiKey("");
                  apply(next);
                })
              }
            >
              {busy ? t("common.saving") : t("vidiq.key.saveAndCheck")}
            </button>
            {keySet && (
              <button type="button" onClick={() => setEditing(false)} disabled={busy} className={secondaryButton}>
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {keySet && (
        <div className="space-y-1 rounded-lg border border-zinc-800 p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-zinc-200">{t("vidiq.balance.title")}</h4>
            <button type="button" disabled={busy || !status.enabled} className={secondaryButton} onClick={() => void run(() => request<VidiqStatus>("/balance", json("POST")), t("vidiq.balance.refreshed"), apply)}>
              {t("vidiq.balance.refresh")}
            </button>
          </div>
          {status.balance ? (
            <div className="space-y-0.5 text-xs text-zinc-300">
              <p className="text-sm text-zinc-100">{t("vidiq.balance.total", { total: formatNumber(status.balance.totalCredits) })}</p>
              {status.balance.renewableCredits !== null && status.balance.maxRenewableCredits !== null && (
                <p>{t("vidiq.balance.renewable", { left: formatNumber(status.balance.renewableCredits), max: formatNumber(status.balance.maxRenewableCredits) })}</p>
              )}
              {status.balance.addOnCredits !== null && <p>{t("vidiq.balance.addOn", { n: formatNumber(status.balance.addOnCredits) })}</p>}
              <p>{t("vidiq.balance.resetsAt", { date: date(status.balance.renewableResetsAt) })}</p>
              <p className="text-zinc-500">{t("vidiq.balance.readAt", { date: date(status.balance.readAt) })}</p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">{t("vidiq.balance.none")}</p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <label className="block text-xs text-zinc-400">
          {t("vidiq.budget.title")}
          <InfoTooltip>{t("vidiq.budget.help")}</InfoTooltip>
          <input type="text" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} className={`${inputClass} max-w-40`} />
        </label>
        {!budgetValid && <p className="text-xs text-amber-400">{t("vidiq.budget.invalid")}</p>}
        <p className="text-xs text-zinc-400">
          {t("vidiq.budget.spent", {
            spent: formatNumber(status.budget.spentInPeriod),
            monthly: formatNumber(status.budget.monthly),
            remaining: formatNumber(status.budget.remaining),
            from: date(status.budget.periodStartsAt),
            to: date(status.budget.periodEndsAt),
          })}
        </p>
        <button
          type="button"
          disabled={busy || !budgetValid || Number(budget.trim()) === status.budget.monthly}
          className={secondaryButton}
          onClick={() => void run(() => request<VidiqStatus>("/settings", json("PATCH", { monthlyBudgetCredits: Number(budget.trim()) })), t("vidiq.budget.saved"), apply)}
        >
          {t("vidiq.budget.save")}
        </button>
      </div>

      {keySet && (
        <div className="space-y-2">
          <button type="button" disabled={busy || !status.enabled} className={secondaryButton} onClick={() => void run(() => request<DriftReport>("/check", json("POST")), null, setReport)}>
            {t("vidiq.check.button")}
          </button>
          {report && (
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">{t("vidiq.check.title", { date: date(report.readAt) })}</p>
              <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                {report.report.map((row) => (
                  <li key={row.tool} className="flex justify-between gap-2">
                    <span className="font-mono text-zinc-300">{row.tool}</span>
                    <span className={row.state === "ok" ? "text-emerald-400" : "text-red-400"}>{row.state === "ok" ? t("vidiq.check.ok") : t(`errors.${row.state}` as UiTextKey)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        <h4 className="text-sm font-medium text-zinc-200">{t("vidiq.ledger.title")}</h4>
        {status.ledger.length === 0 ? (
          <p className="text-xs text-zinc-500">{t("vidiq.ledger.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">{t("vidiq.ledger.time")}</th>
                  <th className="py-1 pr-2 font-normal">{t("vidiq.ledger.caller")}</th>
                  <th className="py-1 pr-2 font-normal">{t("vidiq.ledger.tool")}</th>
                  <th className="py-1 pr-2 font-normal">{t("vidiq.ledger.credits")}</th>
                  <th className="py-1 pr-2 font-normal">{t("vidiq.ledger.outcome")}</th>
                  <th className="py-1 font-normal">{t("vidiq.ledger.error")}</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {status.ledger.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800">
                    <td className="py-1 pr-2 whitespace-nowrap">{date(row.at)}</td>
                    <td className="py-1 pr-2">{t(`vidiq.caller.${row.caller}` as UiTextKey)}</td>
                    <td className="py-1 pr-2 font-mono">{row.tool}</td>
                    <td className="py-1 pr-2">{formatNumber(row.creditsUsed ?? row.statedCost)}</td>
                    <td className="py-1 pr-2">{t(`vidiq.outcome.${row.outcome}` as UiTextKey)}</td>
                    <td className="py-1">{row.errorCode && row.errorCode.startsWith("vidiq_") ? t(`errors.${row.errorCode}` as UiTextKey) : (row.errorCode ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmClear && (
        <ConfirmDialog
          title={t("vidiq.key.clearTitle")}
          description={t("vidiq.key.clearDescription")}
          confirmLabel={t("vidiq.key.clear")}
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            setReport(null);
            void run(() => request<VidiqStatus>("/key", json("DELETE")), t("vidiq.key.removed"), apply);
          }}
        />
      )}
    </div>
  );
}
