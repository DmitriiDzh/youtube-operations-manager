"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText } from "@/lib/ui-text";
import type { UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.9/§3.10/§3.12): Content → «Трансляции» for the active channel. Top to
// bottom in the order the owner works: what the stream is doing now and its buttons; the texts the next Start sends; the
// rotation (what plays, checked against YouTube and the files); the history. Start, Go live, Stop and Edit write to YouTube
// and each opens a dialog first that shows exactly what will be sent (the dry run). Everything else here is local.

type Privacy = "public" | "unlisted" | "private";
type Settings = { title: string; description: string; privacyStatus: Privacy; madeForKids: boolean; orderMode: "sequence" | "shuffle" };
type RotationVideo = {
  videoId: string;
  title: string | null;
  rotationIndex: number;
  originalPath: string;
  videoDurationSeconds: number | null;
  originalDurationSeconds: number | null;
  check: { status: "ok" | "refused" | "unchecked"; reason: string | null; checkedAt: string | null };
  override: { reason: string; at: string } | null;
};
type HelperStatus = {
  state: string;
  passNumber: number;
  position: { index: number; videoId: string | null; offset: number };
  lastExit: { at: number; cause: string; code: number | null } | null;
  progress: { bitrate?: string | null };
  missingVideoId?: string | null;
  updatedAt: number;
};
type Overview = {
  stream: { intent: "on" | "off"; settings: Settings; streamId: string | null; broadcastId: string | null; onSince: string | null } | null;
  rotation: RotationVideo[];
  sources: Array<{ videoId: string; file: string; setBy: string; setAt: string }>;
  module: { enabled: boolean; host: { ok: true } | { ok: false; reason: string } };
  encoder: { running: boolean; status: HelperStatus | null };
  youtube: {
    checkedAt: number;
    lifeCycleStatus: string | null;
    streamStatus: string | null;
    healthStatus: string | null;
    configurationIssues: Array<{ type: string; severity: string | null }>;
    viewers: number | null;
  } | null;
  startPreview: { createsStream: boolean; units: number; liveWritesEnabled: boolean; moduleReady: boolean } | null;
  events: Array<{ id: string; at: string; kind: string; detail: Record<string, unknown> }>;
};

const EMPTY_SETTINGS: Settings = { title: "", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" };
const POLL_MS = 15_000;
const cardClass = "space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const dangerClass = "rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50";

const PRIVACY_KEYS: Record<Privacy, UiTextKey> = { public: "live.privacy.public", unlisted: "live.privacy.unlisted", private: "live.privacy.private" };

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The stream's state in the owner's words (§3.10), from the intent, the encoder and the latest events. */
function streamState(overview: Overview): { key: UiTextKey; tone: "off" | "live" | "warn" | "busy" } {
  const ended = overview.events.find((e) => e.kind === "youtube_ended" || e.kind === "encoder_start" || e.kind === "stopped_by_owner");
  if (overview.stream?.intent !== "on") return ended?.kind === "youtube_ended" ? { key: "live.state.endedByYoutube", tone: "warn" } : { key: "live.state.off", tone: "off" };
  const status = overview.encoder.status;
  if (!overview.encoder.running || !status) return { key: "live.state.starting", tone: "busy" };
  if (status.state === "replaying") return { key: "live.state.replaying", tone: "warn" };
  if (status.state === "waiting_for_source") return { key: "live.state.noSource", tone: "warn" };
  if (status.state === "restarting") return { key: "live.state.reconnecting", tone: "busy" };
  return { key: "live.state.live", tone: "live" };
}

const TONE_CLASS = {
  off: "bg-zinc-800 text-zinc-300",
  live: "bg-red-600 text-white",
  warn: "bg-amber-500/20 text-amber-300",
  busy: "bg-sky-500/20 text-sky-300",
} as const;

export function LiveStreamPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/live-stream` : null;

  const load = useCallback(() => {
    if (!base) return Promise.resolve();
    return requestJson<Overview>(base, undefined, t("live.loadFailed"), t).then(
      (data) => {
        setOverview(data);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(error instanceof Error ? error.message : t("live.loadFailed"))
    );
  }, [base, t]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  if (!channelId) return <p className="text-sm text-zinc-400">{t("live.noChannel")}</p>;
  if (!overview) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
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

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-zinc-400">{t("live.intro")}</p>
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {(!overview.module.enabled || !overview.module.host.ok) && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-500/10 p-3 text-sm text-amber-200">
          {overview.module.host.ok ? t("live.module.off") : t("live.module.hostUnsupported")}{" "}
          <Link href="/settings/live-streams" className="underline hover:text-white">
            {t("live.module.openSettings")}
          </Link>
        </div>
      )}
      <StatusCard overview={overview} base={base!} onChanged={load} />
      <SettingsCard overview={overview} base={base!} onChanged={load} />
      <RotationCard overview={overview} base={base!} onChanged={load} />
      <HistoryCard overview={overview} />
    </div>
  );
}

function StatusCard({ overview, base, onChanged }: { overview: Overview; base: string; onChanged: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"start" | "stop" | "goLive" | null>(null);
  const state = streamState(overview);
  const on = overview.stream?.intent === "on";
  const status = overview.encoder.status;
  const playing = status?.position.videoId ? overview.rotation.find((v) => v.videoId === status.position.videoId) : null;
  const preview = overview.startPreview;
  const settings = overview.stream?.settings ?? EMPTY_SETTINGS;
  const ready = overview.module.enabled && overview.module.host.ok;

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setDialog(null);
    try {
      const result = await action();
      const encoderError = (result as { encoderError?: string } | null)?.encoderError;
      setNotice(encoderError ? t("live.start.encoderLater", { error: encoderError }) : done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-medium text-zinc-100">{t("live.status.title")}</h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[state.tone]}`}>{t(state.key)}</span>
        {on && overview.stream?.onSince && <span className="text-xs text-zinc-500">{t("live.status.since", { at: new Date(overview.stream.onSince).toLocaleString(t.language) })}</span>}
      </div>
      {on && status && (
        <div className="space-y-1 text-sm text-zinc-300">
          <p>
            {t("live.status.nowPlaying", {
              title: playing?.title ?? status.position.videoId ?? "—",
              n: String(status.position.index + 1),
              total: String(overview.rotation.length),
              at: clock(status.position.offset),
            })}
          </p>
          {status.missingVideoId && <p className="text-xs text-amber-300">{t("live.status.missing", { videoId: status.missingVideoId })}</p>}
          {status.lastExit && <p className="text-xs text-zinc-500">{t("live.status.lastExit", { at: new Date(status.lastExit.at).toLocaleString(t.language), cause: status.lastExit.cause })}</p>}
          {status.progress.bitrate && <p className="text-xs text-zinc-500">{t("live.status.bitrate", { bitrate: status.progress.bitrate })}</p>}
        </div>
      )}
      {on && overview.youtube && (
        <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs text-zinc-400">
          <p className="text-zinc-300">
            {/* ui-text-ignore: YouTube's own status words (data) */}
            {t("live.youtube.status", {
              lifecycle: overview.youtube.lifeCycleStatus ?? "—",
              stream: overview.youtube.streamStatus ?? "—",
              health: overview.youtube.healthStatus ?? "—",
            })}
          </p>
          {overview.youtube.viewers !== null && <p>{t("live.youtube.viewers", { viewers: String(overview.youtube.viewers) })}</p>}
          {overview.youtube.configurationIssues.length > 0 && (
            <p className="text-amber-300">{t("live.youtube.issues", { issues: overview.youtube.configurationIssues.map((i) => i.type).join(", ") })}</p>
          )}
          <p className="text-zinc-500">{t("live.youtube.checked", { at: new Date(overview.youtube.checkedAt).toLocaleString(t.language) })}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!on && (
          <button onClick={() => setDialog("start")} disabled={busy || !ready || overview.rotation.length === 0 || !settings.title.trim()} className={primaryClass}>
            {t("live.action.start")}
          </button>
        )}
        {on && (
          <>
            <button onClick={() => setDialog("stop")} disabled={busy} className={dangerClass}>
              {t("live.action.stop")}
            </button>
            <button onClick={() => void run(() => requestJson(`${base}/restart`, json("POST", {}), t("live.actionFailed"), t), t("live.restart.done"))} disabled={busy} className={buttonClass}>
              {t("live.action.restart")}
            </button>
            <button onClick={() => setDialog("goLive")} disabled={busy} className={buttonClass}>
              {t("live.action.goLive")}
            </button>
          </>
        )}
      </div>
      {!on && overview.rotation.length === 0 && <p className="text-xs text-zinc-500">{t("live.start.needRotation")}</p>}
      {!on && overview.rotation.length > 0 && !settings.title.trim() && <p className="text-xs text-zinc-500">{t("live.start.needTitle")}</p>}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}

      {dialog === "start" && preview && (
        <ConfirmDialog
          title={t("live.start.title")}
          description={t("live.start.description")}
          confirmLabel={t("live.action.start")}
          confirmDisabled={!preview.liveWritesEnabled}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(() => requestJson(`${base}/start`, json("POST", {}), t("live.actionFailed"), t), t("live.start.done"))}
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-zinc-500">{t("live.field.title")}</dt>
            <dd className="text-zinc-200">{settings.title}</dd>
            <dt className="text-zinc-500">{t("live.field.description")}</dt>
            <dd className="whitespace-pre-wrap text-zinc-200">{settings.description || "—"}</dd>
            <dt className="text-zinc-500">{t("live.field.privacy")}</dt>
            <dd className="text-zinc-200">{t(PRIVACY_KEYS[settings.privacyStatus])}</dd>
            <dt className="text-zinc-500">{t("live.field.madeForKids")}</dt>
            <dd className="text-zinc-200">{settings.madeForKids ? t("live.yes") : t("live.no")}</dd>
            <dt className="text-zinc-500">{t("live.start.autoStop")}</dt>
            <dd className="text-zinc-200">{t("live.start.autoStopValue")}</dd>
            <dt className="text-zinc-500">{t("live.start.units")}</dt>
            <dd className="text-zinc-200">{t("live.start.unitsValue", { units: String(preview.units) })}</dd>
          </dl>
          {preview.createsStream && <p className="text-xs text-zinc-400">{t("live.start.createsStream")}</p>}
          {!preview.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.liveWritesOff")}</p>}
        </ConfirmDialog>
      )}
      {dialog === "stop" && (
        <ConfirmDialog
          title={t("live.stop.title")}
          description={t("live.stop.description")}
          confirmLabel={preview?.liveWritesEnabled ? t("live.action.stop") : t("live.stop.encoderOnly")}
          confirmVariant="danger"
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(
              () => requestJson(`${base}/stop`, json("POST", { encoderOnly: !preview?.liveWritesEnabled }), t("live.actionFailed"), t),
              preview?.liveWritesEnabled ? t("live.stop.done") : t("live.stop.encoderOnlyDone")
            )
          }
        >
          {!preview?.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.stop.encoderOnlyWarning")}</p>}
        </ConfirmDialog>
      )}
      {dialog === "goLive" && (
        <ConfirmDialog
          title={t("live.goLive.title")}
          description={t("live.goLive.description")}
          confirmLabel={t("live.action.goLive")}
          confirmDisabled={!preview?.liveWritesEnabled}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(() => requestJson(`${base}/go-live`, json("POST", {}), t("live.actionFailed"), t), t("live.goLive.done"))}
        >
          {!preview?.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.liveWritesOff")}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

function SettingsCard({ overview, base, onChanged }: { overview: Overview; base: string; onChanged: () => Promise<void> }) {
  const t = useT();
  const saved = overview.stream?.settings ?? EMPTY_SETTINGS;
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<Settings>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editPreview, setEditPreview] = useState<{ before: { title: string; description: string; privacyStatus: Privacy }; after: { title: string; description: string; privacyStatus: Privacy } } | null>(null);

  // Reset only when the SAVED values change (each poll builds a new object and would wipe unsaved edits).
  useEffect(() => {
    setDraft(JSON.parse(savedKey) as Settings);
  }, [savedKey]);

  const dirty = JSON.stringify(draft) !== savedKey;
  const valid = draft.title.trim().length >= 1 && draft.title.length <= 100 && draft.description.length <= 5000;
  const onAir = overview.stream?.intent === "on" && !!overview.stream.broadcastId;

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const patch = { title: draft.title, description: draft.description, privacyStatus: draft.privacyStatus };

  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("live.settings.title")}
        <InfoTooltip>{t("live.settings.info")}</InfoTooltip>
      </h3>
      <label className="block space-y-1 text-sm text-zinc-400">
        <span>{t("live.field.title")}</span>
        <input type="text" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={busy} className={`${inputClass} w-full`} />
      </label>
      <label className="block space-y-1 text-sm text-zinc-400">
        <span>{t("live.field.description")}</span>
        <textarea value={draft.description} maxLength={5000} rows={4} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={busy} className={`${inputClass} w-full`} />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
        <label className="flex items-center gap-2">
          <span className="text-zinc-400">{t("live.field.privacy")}</span>
          <select value={draft.privacyStatus} onChange={(e) => setDraft({ ...draft, privacyStatus: e.target.value as Privacy })} disabled={busy} className={inputClass}>
            {(Object.keys(PRIVACY_KEYS) as Privacy[]).map((p) => (
              <option key={p} value={p}>
                {t(PRIVACY_KEYS[p])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-zinc-400">{t("live.field.order")}</span>
          <select value={draft.orderMode} onChange={(e) => setDraft({ ...draft, orderMode: e.target.value as Settings["orderMode"] })} disabled={busy} className={inputClass}>
            <option value="sequence">{t("live.order.sequence")}</option>
            <option value="shuffle">{t("live.order.shuffle")}</option>
          </select>
        </label>
        <span className="flex items-center gap-2">
          <ToggleSwitch checked={draft.madeForKids} onChange={(next) => setDraft({ ...draft, madeForKids: next })} disabled={busy} label={t("live.field.madeForKids")} />
          <span>{t("live.field.madeForKids")}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void run(() => requestJson(`${base}/settings`, json("PUT", draft), t("settings.saveFailed"), t), t("live.settings.saved"))} disabled={busy || !dirty || !valid} className={primaryClass}>
          {onAir ? t("live.settings.saveNext") : t("live.settings.save")}
        </button>
        {onAir && (
          <button
            onClick={() =>
              void (async () => {
                setError(null);
                try {
                  setEditPreview(await requestJson(`${base}/edit/preview`, json("POST", { patch }), t("live.actionFailed"), t));
                } catch (err) {
                  setError(err instanceof Error ? err.message : t("live.actionFailed"));
                }
              })()
            }
            disabled={busy || !valid}
            className={buttonClass}
          >
            {t("live.edit.button")}
          </button>
        )}
      </div>
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {editPreview && (
        <ConfirmDialog
          title={t("live.edit.title")}
          description={t("live.edit.description")}
          confirmLabel={t("live.edit.confirm")}
          confirmDisabled={!overview.startPreview?.liveWritesEnabled}
          onCancel={() => setEditPreview(null)}
          onConfirm={() => {
            const expected = editPreview.before;
            setEditPreview(null);
            void run(() => requestJson(`${base}/edit`, json("POST", { patch, expected }), t("live.actionFailed"), t), t("live.edit.done"));
          }}
        >
          <dl className="grid grid-cols-[max-content_1fr_1fr] gap-x-3 gap-y-1 text-xs">
            <dt />
            <dd className="text-zinc-500">{t("live.edit.before")}</dd>
            <dd className="text-zinc-500">{t("live.edit.after")}</dd>
            <dt className="text-zinc-500">{t("live.field.title")}</dt>
            <dd className="text-zinc-300">{editPreview.before.title}</dd>
            <dd className="text-zinc-100">{editPreview.after.title}</dd>
            <dt className="text-zinc-500">{t("live.field.description")}</dt>
            <dd className="whitespace-pre-wrap text-zinc-300">{editPreview.before.description || "—"}</dd>
            <dd className="whitespace-pre-wrap text-zinc-100">{editPreview.after.description || "—"}</dd>
            <dt className="text-zinc-500">{t("live.field.privacy")}</dt>
            <dd className="text-zinc-300">{t(PRIVACY_KEYS[editPreview.before.privacyStatus] ?? "live.privacy.private")}</dd>
            <dd className="text-zinc-100">{t(PRIVACY_KEYS[editPreview.after.privacyStatus] ?? "live.privacy.private")}</dd>
          </dl>
          {!overview.startPreview?.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.liveWritesOff")}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

const REFUSAL_KEYS: Record<string, UiTextKey> = {
  private: "live.refusal.private",
  unlisted: "live.refusal.unlisted",
  scheduled: "live.refusal.scheduled",
  not_found: "live.refusal.notFound",
  unknown: "live.refusal.unknown",
};

function RotationCard({ overview, base, onChanged }: { overview: Overview; base: string; onChanged: () => Promise<void> }) {
  const t = useT();
  const [videoId, setVideoId] = useState("");
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [removeFor, setRemoveFor] = useState<string | null>(null);
  const rotation = overview.rotation;
  const inRotation = useMemo(() => new Set(rotation.map((v) => v.videoId)), [rotation]);
  const offered = overview.sources.filter((s) => !inRotation.has(s.videoId));
  const videoUrl = (id: string) => [base, "rotation", encodeURIComponent(id)].join("/");
  const overrideUrl = (id: string) => [videoUrl(id), "override"].join("/");

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const move = (index: number, delta: number) => {
    const ids = rotation.map((v) => v.videoId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => requestJson(`${base}/rotation`, json("PUT", { videoIds: ids }), t("live.actionFailed"), t), t("live.rotation.reordered"));
  };

  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("live.rotation.title")}
        <InfoTooltip>{t("live.rotation.info")}</InfoTooltip>
      </h3>
      {rotation.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("live.rotation.empty")}</p>
      ) : (
        <ol className="divide-y divide-zinc-800">
          {rotation.map((video, index) => (
            <li key={video.videoId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="w-6 text-right text-xs text-zinc-500">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-zinc-100">{video.title ?? video.videoId}</p>
                <p className="truncate text-xs text-zinc-500">
                  {video.videoId} · {video.originalPath} · {video.originalDurationSeconds !== null ? clock(video.originalDurationSeconds) : "—"}
                </p>
                {video.check.status === "refused" && (
                  <p className="text-xs text-amber-300">{t(REFUSAL_KEYS[video.check.reason ?? "unknown"] ?? "live.refusal.unknown")}{video.override ? ` · ${t("live.override.active", { reason: video.override.reason })}` : ""}</p>
                )}
                {video.check.status !== "refused" && video.override && <p className="text-xs text-zinc-500">{t("live.override.active", { reason: video.override.reason })}</p>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => move(index, -1)} disabled={busy || index === 0} className={buttonClass} aria-label={t("live.rotation.up")}>
                  ↑
                </button>
                <button onClick={() => move(index, 1)} disabled={busy || index === rotation.length - 1} className={buttonClass} aria-label={t("live.rotation.down")}>
                  ↓
                </button>
                {video.override ? (
                  <button onClick={() => void run(() => requestJson(overrideUrl(video.videoId), { method: "DELETE" }, t("live.actionFailed"), t), t("live.override.cleared"))} disabled={busy} className={buttonClass}>
                    {t("live.override.clear")}
                  </button>
                ) : (
                  video.check.status === "refused" && (
                    <button onClick={() => { setOverrideFor(video.videoId); setReason(""); }} disabled={busy} className={buttonClass}>
                      {t("live.override.button")}
                    </button>
                  )
                )}
                <button onClick={() => setRemoveFor(video.videoId)} disabled={busy} className={buttonClass}>
                  {t("live.rotation.remove")}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <p className="text-sm text-zinc-300">{t("live.rotation.add")}</p>
        {offered.length > 0 && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <span>{t("live.rotation.fromMap")}</span>
            <select
              value=""
              onChange={(e) => {
                const source = offered.find((s) => s.videoId === e.target.value);
                if (source) {
                  setVideoId(source.videoId);
                  setFile(source.file);
                }
              }}
              disabled={busy}
              className={`${inputClass} max-w-md`}
            >
              <option value="">{t("live.rotation.pick")}</option>
              {offered.map((s) => (
                <option key={s.videoId} value={s.videoId}>
                  {s.videoId} — {s.file}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input type="text" value={videoId} onChange={(e) => setVideoId(e.target.value.trim())} placeholder={t("live.rotation.videoIdPlaceholder")} aria-label={t("live.rotation.videoId")} disabled={busy} className={`${inputClass} w-40 font-mono`} />
          <input type="text" value={file} onChange={(e) => setFile(e.target.value)} placeholder={t("live.rotation.filePlaceholder")} aria-label={t("live.rotation.file")} disabled={busy} className={`${inputClass} min-w-64 flex-1`} />
          <button
            onClick={() =>
              void run(async () => {
                await requestJson(`${base}/rotation`, json("POST", file.trim() ? { videoId, originalPath: file.trim() } : { videoId }), t("live.actionFailed"), t);
                setVideoId("");
                setFile("");
              }, t("live.rotation.added"))
            }
            disabled={busy || !/^[A-Za-z0-9_-]{11}$/.test(videoId)}
            className={primaryClass}
          >
            {t("live.rotation.addButton")}
          </button>
        </div>
        <p className="text-xs text-zinc-500">{t("live.rotation.addHint")}</p>
      </div>
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {overrideFor && (
        <ConfirmDialog
          title={t("live.override.title")}
          description={t("live.override.description")}
          confirmLabel={t("live.override.confirm")}
          confirmDisabled={reason.trim().length < 5}
          onCancel={() => setOverrideFor(null)}
          onConfirm={() => {
            const id = overrideFor;
            setOverrideFor(null);
            void run(() => requestJson(overrideUrl(id), json("POST", { reason: reason.trim() }), t("live.actionFailed"), t), t("live.override.done"));
          }}
        >
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={t("live.override.reasonPlaceholder")} aria-label={t("live.override.reason")} className={`${inputClass} w-full`} />
        </ConfirmDialog>
      )}
      {removeFor && (
        <ConfirmDialog
          title={t("live.rotation.removeTitle")}
          description={t("live.rotation.removeDescription")}
          confirmLabel={t("live.rotation.remove")}
          confirmVariant="danger"
          onCancel={() => setRemoveFor(null)}
          onConfirm={() => {
            const id = removeFor;
            setRemoveFor(null);
            void run(() => requestJson(videoUrl(id), { method: "DELETE" }, t("live.actionFailed"), t), t("live.rotation.removed"));
          }}
        />
      )}
    </div>
  );
}

const EVENT_KEYS: Record<string, UiTextKey> = {
  youtube_write: "live.event.youtubeWrite",
  encoder_start: "live.event.encoderStart",
  encoder_stop: "live.event.encoderStop",
  encoder_start_failed: "live.event.encoderStartFailed",
  encoder_run_start: "live.event.runStart",
  encoder_run_exit: "live.event.runExit",
  encoder_pass_end: "live.event.passEnd",
  encoder_replay_start: "live.event.replayStart",
  encoder_waiting_for_source: "live.event.waitingForSource",
  encoder_stopped: "live.event.encoderStopped",
  buffer_copied: "live.event.bufferCopied",
  buffer_removed: "live.event.bufferRemoved",
  buffer_missing: "live.event.bufferMissing",
  buffer_restored: "live.event.bufferRestored",
  youtube_ended: "live.event.youtubeEnded",
  stopped_by_owner: "live.event.stoppedByOwner",
  settings_saved: "live.event.settingsSaved",
  rotation_add: "live.event.rotationAdd",
  rotation_remove: "live.event.rotationRemove",
  rotation_reorder: "live.event.rotationReorder",
  guard_refused: "live.event.guardRefused",
  guard_override: "live.event.guardOverride",
  guard_override_cleared: "live.event.guardOverrideCleared",
  sources_set: "live.event.sourcesSet",
};

function HistoryCard({ overview }: { overview: Overview }) {
  const t = useT();
  return (
    <div className={cardClass}>
      <h3 className="text-base font-medium text-zinc-100">{t("live.history.title")}</h3>
      {overview.events.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("live.history.empty")}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {overview.events.map((event) => {
            const key = EVENT_KEYS[event.kind];
            const detail = event.detail;
            const what = typeof detail.method === "string" ? detail.method : typeof detail.videoId === "string" ? detail.videoId : typeof detail.cause === "string" ? detail.cause : typeof detail.reason === "string" ? detail.reason : "";
            return (
              <li key={event.id} className="flex gap-3">
                <span className="shrink-0 text-zinc-500">{new Date(event.at).toLocaleString(t.language)}</span>
                <span className="text-zinc-300">
                  {key ? t(key) : event.kind}
                  {what ? ` · ${what}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
