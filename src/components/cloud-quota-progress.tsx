"use client";

import { useState } from "react";
import { ProgressBar } from "./progress-bar";
import { QuotaHistoryDialog } from "./quota-history-dialog";
import { QuotaResetTime } from "./quota-reset-time";

export type ServiceQuotaStatusView = {
  limit: number;
  usedLast24h: number;
  window?: "since_reset" | "rolling_24h";
  resetsAt?: string | null;
  /** Units every device's own log recorded in the same window; drawn as the dimmer layer under Google's lagging figure. */
  ledgerUnits?: number;
} | null;

/**
 * Real Google Cloud quota limit/usage for one service, rendered under a gateway toggle in
 * Settings (owner instruction, 2026-09-22 -- "сколько максимальная квота... сколько из неё уже
 * использовано"). `status` is `null`/`undefined` when Cloud isn't connected yet or the real
 * Monitoring API query failed -- renders nothing rather than a fabricated 0/0 bar in that case
 * (`src/lib/cloud-quotas` never invents a number it didn't actually get back from Google).
 */
export function CloudQuotaProgress({
  status,
  size = "sm",
  historyService,
}: {
  status: ServiceQuotaStatusView | undefined;
  size?: "sm" | "lg";
  /** BL-117: when set, a small clock button next to the bar opens the quota-spend history popup for that API. */
  historyService?: "data" | "analytics";
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!status) return null;

  const sinceReset = status.window === "since_reset";
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <ProgressBar
          value={status.usedLast24h}
          max={status.limit}
          size={size}
          underlayValue={status.ledgerUnits}
          label={`Google Cloud quota (${sinceReset ? "since reset" : "24h"}): ${status.usedLast24h.toLocaleString()} / ${status.limit.toLocaleString()}`}
        />
        {status.ledgerUnits !== undefined && (
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Dim layer: our log of all devices, {status.ledgerUnits.toLocaleString()} units. Google&apos;s figure lags by minutes and catches up.
          </p>
        )}
        {status.resetsAt && (
          <p className="mt-0.5 text-[11px] text-zinc-500">Resets <QuotaResetTime iso={status.resetsAt} /> (midnight Pacific Time)</p>
        )}
      </div>
      {historyService && (
        <button
          onClick={() => setHistoryOpen(true)}
          aria-label="Quota history"
          title="Quota history"
          className="mt-0.5 shrink-0 rounded-md border border-zinc-700 p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" />
            <path d="M10 5.5V10l3 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {historyService && historyOpen && <QuotaHistoryDialog service={historyService} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

export type PerMinuteQuotaStatusView = { limit: number; usedLastMinute: number } | null;

/**
 * Same idea as `CloudQuotaProgress`, but for a service (Cloud Monitoring API itself, found live
 * 2026-09-22) that has no daily quota to show -- only a per-minute one. Deliberately a distinct
 * label ("per minute," not "24h") and color (indigo, matching "Connect Google Cloud" / "Save /
 * Apply" -- owner instruction, 2026-09-22: "можем и цвет ему дать фиолетовый, так же как у
 * кнопки соединения с Cloud") so it reads as structurally different at a glance, not just a
 * fourth copy of the same red 24h bar.
 */
export function CloudQuotaProgressPerMinute({
  status,
  size = "sm",
}: {
  status: PerMinuteQuotaStatusView | undefined;
  size?: "sm" | "lg";
}) {
  if (!status) return null;

  return (
    <ProgressBar
      value={status.usedLastMinute}
      max={status.limit}
      color="indigo"
      size={size}
      label={`Google Cloud quota (per minute): ${status.usedLastMinute.toLocaleString()} / ${status.limit.toLocaleString()}`}
    />
  );
}
