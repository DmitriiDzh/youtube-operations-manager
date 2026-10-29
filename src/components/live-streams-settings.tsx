"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.12, ADR 0036 §1–2): Settings → «Трансляции», this computer only. The
// module switch (it turns on only on the Mac running as the system service), the buffer and disk thresholds, the encoder,
// bitrate, the alert delay and an optional ffmpeg folder. Text inputs (not native number widgets), so the digits read the
// same in every locale.

type Encoder = "h264_videotoolbox" | "libx264";
type Settings = {
  enabled: boolean;
  bufferDepth: number;
  warnBelowGb: number;
  refuseBelowGb: number;
  bitrateKbps: number;
  encoder: Encoder;
  alertMinutes: number;
  ffmpegDir: string | null;
  uploadCapMbps: number;
  uploadGuardMinutes: number;
  host: { ok: true } | { ok: false; reason: string };
};

// BL-233 (FO-REQ-0047): the upload limit while live (Mbit/s, 0 = none) and the minutes before an upload pauses (0 = never).
const NUMBER_FIELDS = ["bufferDepth", "warnBelowGb", "refuseBelowGb", "bitrateKbps", "alertMinutes", "uploadCapMbps", "uploadGuardMinutes"] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];
const RANGES: Record<NumberField, [number, number, boolean]> = {
  bufferDepth: [1, 6, true],
  warnBelowGb: [1, 1000, false],
  refuseBelowGb: [1, 1000, false],
  bitrateKbps: [1000, 12000, true],
  alertMinutes: [1, 60, true],
  uploadCapMbps: [0, 100, false],
  uploadGuardMinutes: [0, 60, true],
};

const inputClass = "w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

function parseField(field: NumberField, text: string): number | null {
  const [min, max, integer] = RANGES[field];
  const trimmed = text.trim().replace(",", ".");
  if (!(integer ? /^\d{1,6}$/ : /^\d{1,4}(\.\d{1,2})?$/).test(trimmed)) return null;
  const value = Number(trimmed);
  // BL-233: the upload limit is 0 (none) or at least 0.5 Mbit/s, as the server checks.
  if (field === "uploadCapMbps" && value > 0 && value < 0.5) return null;
  return value >= min && value <= max ? value : null;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function LiveStreamsSettings() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Record<NumberField, string> & { encoder: Encoder; ffmpegDir: string }>({
    bufferDepth: "",
    warnBelowGb: "",
    refuseBelowGb: "",
    bitrateKbps: "",
    alertMinutes: "",
    uploadCapMbps: "",
    uploadGuardMinutes: "",
    encoder: "h264_videotoolbox",
    ffmpegDir: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((data: Settings) => {
    setSettings(data);
    setDrafts({
      bufferDepth: String(data.bufferDepth),
      warnBelowGb: String(data.warnBelowGb),
      refuseBelowGb: String(data.refuseBelowGb),
      bitrateKbps: String(data.bitrateKbps),
      alertMinutes: String(data.alertMinutes),
      uploadCapMbps: String(data.uploadCapMbps),
      uploadGuardMinutes: String(data.uploadGuardMinutes),
      encoder: data.encoder,
      ffmpegDir: data.ffmpegDir ?? "",
    });
  }, []);

  const load = useCallback(
    (options: { resetDrafts?: boolean } = {}) =>
      requestJson<Settings>("/api/live-streams/settings", undefined, t("settings.loadFailed"), t).then(
        (data) => {
          // A toggle reloads the switch only: unsaved number, encoder and folder edits stay (independent review).
          if (options.resetDrafts === false) setSettings(data);
          else apply(data);
          setError(null);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("settings.loadFailed"))
      ),
    [apply, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function put(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/live-streams/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }, t("settings.saveFailed"), t);
      setNotice(done);
      await load({ resetDrafts: !(Object.keys(patch).length === 1 && "enabled" in patch) });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {error ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={() => void load()} className={buttonClass}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  const parsed = Object.fromEntries(NUMBER_FIELDS.map((f) => [f, parseField(f, drafts[f])])) as Record<NumberField, number | null>;
  const valid = NUMBER_FIELDS.every((f) => parsed[f] !== null) && (parsed.refuseBelowGb ?? 0) < (parsed.warnBelowGb ?? 0);
  const ffmpegDir = drafts.ffmpegDir.trim() || null;
  const dirty = valid && (NUMBER_FIELDS.some((f) => parsed[f] !== settings[f]) || drafts.encoder !== settings.encoder || ffmpegDir !== settings.ffmpegDir);
  const labels: Record<NumberField, string> = {
    bufferDepth: t("liveSettings.bufferDepth"),
    warnBelowGb: t("liveSettings.warnBelowGb"),
    refuseBelowGb: t("liveSettings.refuseBelowGb"),
    bitrateKbps: t("liveSettings.bitrateKbps"),
    alertMinutes: t("liveSettings.alertMinutes"),
    uploadCapMbps: t("liveSettings.uploadCapMbps"),
    uploadGuardMinutes: t("liveSettings.uploadGuardMinutes"),
  };

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("liveSettings.title")}
        <InfoTooltip>{t("liveSettings.info")}</InfoTooltip>
      </h3>
      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={settings.enabled}
          onChange={(next) => void put({ enabled: next }, next ? t("liveSettings.turnedOn") : t("liveSettings.turnedOff"))}
          disabled={busy || (!settings.enabled && !settings.host.ok)}
          label={t("liveSettings.switch")}
        />
        <span className="text-sm text-zinc-200">{t("liveSettings.switch")}</span>
      </div>
      {!settings.host.ok && <p className="text-xs text-amber-400">{t("liveSettings.hostUnsupported")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {NUMBER_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="text"
              inputMode="decimal"
              value={drafts[field]}
              onChange={(e) => setDrafts((current) => ({ ...current, [field]: e.target.value }))}
              disabled={busy}
              aria-label={labels[field]}
              className={`${inputClass} ${parsed[field] === null ? "border-red-700" : ""}`}
            />
            <span>{labels[field]}</span>
          </label>
        ))}
      </div>
      {parsed.refuseBelowGb !== null && parsed.warnBelowGb !== null && parsed.refuseBelowGb >= parsed.warnBelowGb && <p className="text-xs text-red-400">{t("liveSettings.refuseBelowWarn")}</p>}
      <p className="text-xs text-zinc-500">{t("liveSettings.upload.hint")}</p>
      <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <span>{t("liveSettings.encoder")}</span>
        <select value={drafts.encoder} onChange={(e) => setDrafts((current) => ({ ...current, encoder: e.target.value as Encoder }))} disabled={busy} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100">
          <option value="h264_videotoolbox">{t("liveSettings.encoder.videotoolbox")}</option>
          <option value="libx264">{t("liveSettings.encoder.libx264")}</option>
        </select>
      </label>
      <p className="text-xs text-zinc-500">{t("liveSettings.encoder.hint")}</p>
      <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <span>{t("liveSettings.ffmpegDir")}</span>
        <input type="text" value={drafts.ffmpegDir} onChange={(e) => setDrafts((current) => ({ ...current, ffmpegDir: e.target.value }))} placeholder={t("liveSettings.ffmpegDirPlaceholder")} disabled={busy} className="w-72 max-w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100" />
      </label>
      <button
        onClick={() => void put({ ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f, parsed[f]])), encoder: drafts.encoder, ffmpegDir }, t("liveSettings.saved"))}
        disabled={busy || !dirty}
        className={primaryClass}
      >
        {t("liveSettings.save")}
      </button>
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
    </div>
  );
}
