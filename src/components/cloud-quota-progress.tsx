"use client";

import { ProgressBar } from "./progress-bar";

export type ServiceQuotaStatusView = { limit: number; usedLast24h: number } | null;

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
}: {
  status: ServiceQuotaStatusView | undefined;
  size?: "sm" | "lg";
}) {
  if (!status) return null;

  return (
    <ProgressBar
      value={status.usedLast24h}
      max={status.limit}
      size={size}
      label={`Google Cloud quota (24h): ${status.usedLast24h.toLocaleString()} / ${status.limit.toLocaleString()}`}
    />
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
