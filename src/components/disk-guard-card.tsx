"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type Translate, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): Servers → Sessions → «Диск». This computer's free space on the volumes
// the app writes to, the alert the server's 15-minute check raised (if any), the app's biggest folders (measured only on the
// button: the walk takes seconds) and the alert threshold. Reads only `/api/disk-guard`; wrapped in its own error boundary
// (AGENTS.md §M), so a failure here never affects the rest of Servers.

type Volume = { labels: Array<"appData" | "program">; path: string; freeBytes: number; totalBytes: number };
type Consumer = { key: "liveStreamsBuffer" | "backups" | "nextCache" | "tempDir"; path: string; bytes: number; complete: boolean };
type View = {
  settings: { thresholdGb: number };
  volumes: Volume[];
  volumesError: string | null;
  notice: { freeBytes: number; thresholdGb: number; since: string } | null;
  lastCheckAt: string | null;
  consumers: Consumer[] | null;
};

const GB = 1_000_000_000;
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

/** Bytes as "12.3 GB" (exported for the bell and the test). */
export function gbLabel(t: Translate, bytes: number): string {
  return t("unit.gb", { value: (bytes / GB).toFixed(1) });
}

/** The threshold field's value as a number of GB, or null when it is not one from 1 to 10000 (exported for the test). */
export function parseThresholdGb(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value >= 1 && value <= 10_000 ? value : null;
}

const CONSUMER_TEXT: Record<Consumer["key"], UiTextKey> = {
  liveStreamsBuffer: "disk.consumer.liveStreamsBuffer",
  backups: "disk.consumer.backups",
  nextCache: "disk.consumer.nextCache",
  tempDir: "disk.consumer.tempDir",
};

export function DiskGuardCard() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(
    (measure: boolean) =>
      fetch(`/api/disk-guard${measure ? "?measure=1" : ""}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as View | null;
          if (!res.ok || !body) throw new Error(errorText(t, body, t("settings.loadFailed"), { showErrorField: false }));
          setView(body);
          setError(null);
          if (body.consumers) setConsumers(body.consumers);
          setThreshold((current) => (current === "" ? String(body.settings.thresholdGb) : current));
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : t("settings.loadFailed"))),
    [t]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  async function measure() {
    setMeasuring(true);
    await load(true);
    setMeasuring(false);
  }

  const parsedThreshold = parseThresholdGb(threshold);
  async function saveThreshold() {
    if (parsedThreshold === null) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const res = await fetch("/api/disk-guard/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thresholdGb: parsedThreshold }) });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveError(errorText(t, body, t("common.errorStatus", { status: res.status })));
        return;
      }
      setSaved(true);
      await load(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const volumeLabel = (volume: Volume) => volume.labels.map((label) => t(label === "appData" ? "disk.volume.appData" : "disk.volume.program")).join(" · ");
  const sortedConsumers = consumers ? [...consumers].sort((a, b) => b.bytes - a.bytes) : null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("disk.title")}
          <InfoTooltip>{t("disk.info")}</InfoTooltip>
        </h3>
      </div>
      {error && <p className="text-sm text-amber-400">{error}</p>}
      {!view && !error && <LoadingIndicator className="text-sm text-zinc-400" />}
      {view && (
        <>
          {view.notice && (
            <p className="rounded-lg border border-red-800 bg-red-950/40 p-2.5 text-sm text-red-200">
              {t("disk.alert", { free: gbLabel(t, view.notice.freeBytes), threshold: view.notice.thresholdGb, since: formatDisplayDateTime(new Date(view.notice.since)) })}
            </p>
          )}
          {view.volumesError && <p className="text-sm text-amber-400">{t("disk.volumesError", { error: view.volumesError })}</p>}
          <div className="space-y-2">
            {view.volumes.map((volume) => {
              const usedShare = volume.totalBytes > 0 ? 1 - volume.freeBytes / volume.totalBytes : 0;
              const low = volume.freeBytes < view.settings.thresholdGb * GB;
              return (
                <div key={volume.path} className="space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="text-zinc-200">{volumeLabel(volume)}</span>
                    <span className={low ? "text-red-300" : "text-zinc-300"}>{t("disk.volume.free", { free: gbLabel(t, volume.freeBytes), total: gbLabel(t, volume.totalBytes) })}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div className={`h-full ${low ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, usedShare)) * 100)}%` }} />
                  </div>
                  {/* ui-text-ignore: a folder path (data) */}
                  <p className="truncate text-xs text-zinc-500">{volume.path}</p>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-zinc-500">{t("disk.lastCheck", { at: view.lastCheckAt ? formatDisplayDateTime(new Date(view.lastCheckAt)) : t("common.never") })}</p>

          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-zinc-200">{t("disk.consumers.title")}</h4>
              <button type="button" onClick={() => void measure()} disabled={measuring} className={buttonClass}>
                {measuring ? t("disk.consumers.measuring") : t("disk.consumers.measure")}
              </button>
            </div>
            <p className="text-xs text-zinc-500">{t("disk.consumers.hint")}</p>
            {sortedConsumers && (
              <ul className="space-y-1 text-sm">
                {sortedConsumers.map((consumer) => (
                  <li key={consumer.key} className="flex items-baseline justify-between gap-2" title={consumer.path}>
                    <span className="text-zinc-300">{t(CONSUMER_TEXT[consumer.key])}</span>
                    <span className="text-zinc-200">{consumer.complete ? gbLabel(t, consumer.bytes) : t("disk.consumer.atLeast", { size: gbLabel(t, consumer.bytes) })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              {t("disk.threshold.label")}
              <input
                type="text"
                inputMode="decimal"
                value={threshold}
                onChange={(event) => {
                  setThreshold(event.target.value);
                  setSaved(false);
                }}
                className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
              />
            </label>
            <button
              type="button"
              onClick={() => void saveThreshold()}
              disabled={saving || parsedThreshold === null || parsedThreshold === view.settings.thresholdGb}
              className={buttonClass}
            >
              {t("disk.threshold.save")}
            </button>
            {saved && <span className="text-xs text-emerald-400">{t("disk.threshold.saved")}</span>}
            {parsedThreshold === null && threshold.trim() !== "" && <span className="text-xs text-red-400">{t("disk.threshold.invalid")}</span>}
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          </div>
        </>
      )}
    </div>
  );
}
