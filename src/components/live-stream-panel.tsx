"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@/lib/ui-text";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, BusyOverlay, StatusNotice, useBusyAction } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import type { LiveLatency, LiveVideoSettings } from "@/lib/live-streams/fields";
import { LiveStreamAddVideosDialog } from "./live-stream-add-videos-dialog";
import { LiveStreamVideoSettingsCard } from "./live-stream-video-settings";
import { LiveStreamLocalizationsCard } from "./live-stream-localizations";
import type { LiveLocalizationsView } from "@/lib/live-streams/localizations";
import { LiveStreamSegmentsCard, type SegmentsViewData } from "./live-stream-segments";
import { LiveStreamAnalyticsCard } from "./live-stream-analytics";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";
import { UploadBandwidthNote } from "./upload-bandwidth-note";

// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.9/§3.10/§3.12): Content → «Трансляции» for the active channel. Top to
// bottom in the order the owner works: what the stream is doing now and its buttons; the texts the next Start sends; the
// rotation (what plays, checked against YouTube and the files); the history. Start, Go live, Stop and Edit write to YouTube
// and each opens a dialog first that shows exactly what will be sent (the dry run). Everything else here is local.

type Privacy = "public" | "unlisted" | "private";
/** `bitrateKbps` (BL-233): the stream's own encoder bitrate; null = this computer's setting. */
type Settings = { title: string; description: string; privacyStatus: Privacy; madeForKids: boolean; orderMode: "sequence" | "shuffle"; bitrateKbps: number | null };
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
  passVideoIds?: string[];
  position: { index: number; videoId: string | null; offset: number };
  lastExit: { at: number; cause: string; code: number | null } | null;
  progress: { bitrate?: string | null; speed?: string | null };
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
  startPreview: {
    createsStream: boolean;
    units: number;
    liveWritesEnabled: boolean;
    moduleReady: boolean;
    /** BL-186: the broadcast settings the insert carries (null = never saved: YouTube's defaults). */
    broadcast?: { settings: LiveVideoSettings["broadcast"] | null };
    /** BL-186: the saved video-level settings. */
    videoSettings?: Omit<LiveVideoSettings, "broadcast"> | null;
    /** BL-186 stage 3: exactly what Start sends to the broadcast's video right after it starts (null: nothing, or not available). */
    videoSettingsApply?: VideoApplyPreview | null;
    videoSettingsProblem?: string | null;
  } | null;
  videoSettings: LiveVideoSettings | null;
  videoSettingsProblem: string | null;
  /** BL-205: «Перезапуск эфира» -- the segment settings, the running segment and the last 30 days. */
  segments?: SegmentsViewData | null;
  /** Owner msg 3153: the channel's baseline title/description language -- the broadcast's language. */
  channelDefaultLanguage?: string | null;
  /** BL-207: the stream's translations, their warnings and the last localizations step. */
  localizations?: LiveLocalizationsView | null;
  /** BL-186 stage 3: the last video settings summary (any age). */
  videoSettingsLast?: { at: string; detail: Record<string, unknown> } | null;
  events: Array<{ id: string; at: string; kind: string; detail: Record<string, unknown> }>;
  state: StreamState;
  peers: Array<{ deviceId: string; hostName: string | null; updatedAt: string; stream: { state: StreamState; since: string | null; playing: { index: number; total: number; videoId: string } | null; viewers: number | null } }>;
};

/** BL-186 stage 3: what «Применить снова» (and Start) send to the broadcast's video, and its quota units. */
type VideoApplyPreview = { patch: Record<string, unknown>; thumbnail: boolean; playlists: Array<{ id: string; title: string }>; units: number; localizations?: string[] };
type VideoApplyStep = { step: string; ok: boolean; skipped?: string; error?: string };
type VideoApplyResult = { broadcastId: string; ok: boolean; steps: VideoApplyStep[]; notApplied?: string };

type StreamState = "off" | "ended_by_youtube" | "starting" | "live" | "replaying" | "no_source" | "reconnecting";

const EMPTY_SETTINGS: Settings = { title: "", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence", bitrateKbps: null };
const POLL_MS = 15_000;
const cardClass = "space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const dangerClass = "rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50";

const PRIVACY_KEYS: Record<Privacy, UiTextKey> = { public: "live.privacy.public", unlisted: "live.privacy.unlisted", private: "live.privacy.private" };

/** Why the encoder stopped, or why the app stopped it, in the owner's words (codes come from the helper and the server). */
const CAUSE_KEYS: Record<string, UiTextKey> = {
  encoder_exit: "live.cause.encoderExit",
  source_missing: "live.cause.sourceMissing",
  pass_end: "live.cause.passEnd",
  replay_end: "live.cause.replayEnd",
  owner_stop: "live.cause.ownerStop",
  owner_restart: "live.cause.ownerRestart",
  owner_encoder_only: "live.cause.ownerEncoderOnly",
  module_off: "live.cause.moduleOff",
  intent_off: "live.cause.intentOff",
  hung: "live.cause.hung",
  youtube_complete: "live.cause.youtubeEnded",
  youtube_revoked: "live.cause.youtubeEnded",
  youtube_not_found: "live.cause.youtubeNotFound",
  liveBroadcastNotFound: "live.cause.youtubeNotFound",
  invalidTransition: "live.cause.neverLive",
};

function causeText(t: ReturnType<typeof useT>, code: string): string {
  const key = CAUSE_KEYS[code];
  return key ? t(key) : code;
}

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

/** The stream's state in the owner's words (§3.10); the server derives it in the same vocabulary as the report. */
const STATE_VIEW: Record<StreamState, { key: UiTextKey; tone: "off" | "live" | "warn" | "busy" }> = {
  off: { key: "live.state.off", tone: "off" },
  ended_by_youtube: { key: "live.state.endedByYoutube", tone: "warn" },
  starting: { key: "live.state.starting", tone: "busy" },
  live: { key: "live.state.live", tone: "live" },
  replaying: { key: "live.state.replaying", tone: "warn" },
  no_source: { key: "live.state.noSource", tone: "warn" },
  reconnecting: { key: "live.state.reconnecting", tone: "busy" },
};

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
    <div className="space-y-6">
      <p className="max-w-4xl text-sm text-zinc-400">{t("live.intro")}</p>
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {(!overview.module.enabled || !overview.module.host.ok) && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-500/10 p-3 text-sm text-amber-200">
          {overview.module.host.ok ? t("live.module.off") : t("live.module.hostUnsupported")}{" "}
          {overview.module.host.ok && (
            <Link href="/settings/live-streams" className="underline hover:text-white">
              {t("live.module.openSettings")}
            </Link>
          )}
        </div>
      )}
      {overview.peers.map((peer) => (
        <div key={peer.deviceId} className={cardClass}>
          <div className="flex flex-wrap items-center gap-3">
            {/* ui-text-ignore: the other computer's own name (data) */}
            <h3 className="text-base font-medium text-zinc-100">{t("live.peer.title", { host: peer.hostName ?? peer.deviceId })}</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[STATE_VIEW[peer.stream.state].tone]}`}>{t(STATE_VIEW[peer.stream.state].key)}</span>
          </div>
          {peer.stream.playing && <p className="text-sm text-zinc-300">{t("live.peer.playing", { n: String(peer.stream.playing.index + 1), total: String(peer.stream.playing.total), videoId: peer.stream.playing.videoId })}</p>}
          {peer.stream.viewers !== null && <p className="text-xs text-zinc-400">{t("live.youtube.viewers", { viewers: String(peer.stream.viewers) })}</p>}
          <p className="text-xs text-zinc-500">{t("live.peer.updated", { at: new Date(peer.updatedAt).toLocaleString(t.language) })}</p>
        </div>
      ))}
      {overview.module.host.ok && (
        <>
          {/* BL-221 (CONTENT_UX_PLAN.md stage C): the state and the figures first, full width; what is set once is folded. */}
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <StatusCard overview={overview} base={base!} onChanged={load} />
            <LiveStreamAnalyticsCard base={base!} visible={visible} />
          </div>
          <div className="max-w-4xl space-y-6">
            <RotationCard overview={overview} base={base!} onChanged={load} />
            <details className="group rounded-xl border border-zinc-800 bg-zinc-900">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-200 hover:text-white">{t("live.settingsGroup")}</summary>
              <div className="space-y-6 border-t border-zinc-800 p-3">
                <SettingsCard overview={overview} base={base!} onChanged={load} />
                <LiveStreamLocalizationsCard base={base!} view={overview.localizations ?? null} channelLanguage={overview.channelDefaultLanguage ?? null} hasStream={overview.stream !== null} onChanged={load} />
                <LiveStreamVideoSettingsCard base={base!} channelLanguage={overview.channelDefaultLanguage ?? null} saved={overview.videoSettings} problem={overview.videoSettingsProblem} onChanged={load} />
                <LiveStreamSegmentsCard base={base!} view={overview.segments ?? null} onChanged={load} />
              </div>
            </details>
            <HistoryCard overview={overview} />
          </div>
        </>
      )}
      {/* BL-222: the stream runs on another computer -- its shared «Эфиры» summary, read-only. */}
      {!overview.module.host.ok && <LiveStreamAnalyticsCard base={base!} visible={visible} remote />}
      {!overview.module.host.ok && overview.peers.length === 0 && <p className="text-sm text-zinc-500">{t("live.peer.none")}</p>}
    </div>
  );
}

/** BL-221: YouTube's word for the stream's health, and what it means for the owner. */
const HEALTH_VIEW: Record<string, { key: UiTextKey; className: string }> = {
  good: { key: "live.health.good", className: "border-emerald-800/60 bg-emerald-950/30 text-emerald-200" },
  ok: { key: "live.health.ok", className: "border-emerald-800/60 bg-emerald-950/30 text-emerald-200" },
  bad: { key: "live.health.bad", className: "border-red-800/70 bg-red-950/40 text-red-200" },
  noData: { key: "live.health.noData", className: "border-amber-800/60 bg-amber-950/30 text-amber-200" },
  revoked: { key: "live.health.revoked", className: "border-red-800/70 bg-red-950/40 text-red-200" },
};
/** The configuration issues explained in plain words (liveStreams `status.healthStatus.configurationIssues[].type`); others by name. */
const ISSUE_TEXT: Record<string, UiTextKey> = {
  videoIngestionStarved: "live.issue.videoIngestionStarved",
  videoIngestionFasterThanExpected: "live.issue.videoIngestionFasterThanExpected",
  bitrateLow: "live.issue.bitrateLow",
  bitrateHigh: "live.issue.bitrateHigh",
  gopSizeLong: "live.issue.gop",
  gopSizeOver: "live.issue.gop",
  openGop: "live.issue.gop",
  frameRateHigh: "live.issue.frameRateHigh",
  noAudioStream: "live.issue.noAudioStream",
  noVideoStream: "live.issue.noVideoStream",
};

/**
 * BL-221 (CONTENT_UX_PLAN.md stage C): the stream's state at a glance -- viewers now (a live broadcast without a count is 0
 * viewers, owner msg 3453) and YouTube's health with what each reported issue means. YouTube's own words stay visible as data.
 */
function YoutubeHealth({ youtube }: { youtube: NonNullable<Overview["youtube"]> }) {
  const t = useT();
  const health = youtube.healthStatus ? HEALTH_VIEW[youtube.healthStatus] : undefined;
  const viewers = youtube.viewers ?? (youtube.lifeCycleStatus === "live" ? 0 : null);
  const issues = [...new Map(youtube.configurationIssues.map((issue) => [issue.type, issue])).values()];
  return (
    <div className={`space-y-2 rounded-lg border p-3 ${health?.className ?? "border-zinc-800 bg-zinc-950 text-zinc-300"}`}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {viewers !== null && (
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums text-white">{viewers}</span> {t("live.health.viewersNow")}
          </p>
        )}
        <p className="text-sm font-medium">{health ? t(health.key) : t("live.health.unknown")}</p>
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {issues.map((issue) => (
            <li key={issue.type}>
              {/* ui-text-ignore: YouTube's own issue name (data) */}
              <span className="font-mono opacity-80">{issue.type}</span>
              {" — "}
              {t(ISSUE_TEXT[issue.type] ?? "live.issue.other")}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs opacity-70">
        {/* ui-text-ignore: YouTube's own status words (data) */}
        {t("live.youtube.status", { lifecycle: youtube.lifeCycleStatus ?? "—", stream: youtube.streamStatus ?? "—", health: youtube.healthStatus ?? "—" })}
        {" · "}
        {t("live.youtube.checked", { at: new Date(youtube.checkedAt).toLocaleString(t.language) })}
      </p>
    </div>
  );
}

function StatusCard({ overview, base, onChanged }: { overview: Overview; base: string; onChanged: () => Promise<void> }) {
  const t = useT();
  // BL-195 (UI_FEEDBACK_CLARITY_PLAN.md stage C): start, stop, restart and go live act on YouTube and the encoder -- each runs
  // behind the blocking window with its own text.
  const busyAction = useBusyAction();
  const busy = busyAction.busy;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"start" | "stop" | "goLive" | "applyVideo" | null>(null);
  const [applyPreview, setApplyPreview] = useState<(VideoApplyPreview & { liveWritesEnabled: boolean }) | null>(null);
  const state = STATE_VIEW[overview.state] ?? STATE_VIEW.off;
  const on = overview.stream?.intent === "on";
  const status = overview.encoder.status;
  const playing = status?.position.videoId ? overview.rotation.find((v) => v.videoId === status.position.videoId) : null;
  const preview = overview.startPreview;
  const settings = overview.stream?.settings ?? EMPTY_SETTINGS;
  const ready = overview.module.enabled && overview.module.host.ok;

  async function run(action: () => Promise<unknown>, done: string, working: string) {
    setError(null);
    setNotice(null);
    setDialog(null);
    await busyAction.run(working, async () => {
      try {
        const result = await action();
        const encoderError = (result as { encoderError?: string } | null)?.encoderError;
        const youtubeRefusal = (result as { youtubeRefusal?: string } | null)?.youtubeRefusal;
        const recordingForced = (result as { recordingForced?: boolean } | null)?.recordingForced === true;
        const applied = (result as { steps?: unknown } | null)?.steps ? (result as VideoApplyResult) : null;
        // BL-195: a partial result is kept on screen until closed (an error line); a plain success hides itself.
        if (encoderError) setError(t("live.start.encoderLater", { error: encoderError }));
        else if (youtubeRefusal) setError(t("live.stop.noBroadcast", { reason: causeText(t, youtubeRefusal) }));
        else if (applied && !applied.ok) setError(t("live.videoApply.someFailed", { steps: failedStepsText(t, applied.steps) }));
        else setNotice(recordingForced ? t("live.start.doneRecording") : done);
        await onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("live.actionFailed"));
      }
    });
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
              total: String(status.passVideoIds?.length ?? overview.rotation.length),
              at: clock(status.position.offset),
            })}
          </p>
          {status.missingVideoId && <p className="text-xs text-amber-300">{t("live.status.missing", { videoId: status.missingVideoId })}</p>}
          {status.lastExit && <p className="text-xs text-zinc-500">{t("live.status.lastExit", { at: new Date(status.lastExit.at).toLocaleString(t.language), cause: causeText(t, status.lastExit.cause) })}</p>}
          {status.progress.bitrate && (
            <p className="text-xs text-zinc-500">
              {t("live.status.bitrate", { bitrate: status.progress.bitrate })}
              {status.progress.speed ? ` · ${t("live.status.speed", { speed: status.progress.speed })}` : ""}
            </p>
          )}
        </div>
      )}
      {on && <UploadBandwidthNote />}
      {on && overview.youtube && <YoutubeHealth youtube={overview.youtube} />}
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
            <button onClick={() => void run(() => requestJson(`${base}/restart`, json("POST", {}), t("live.actionFailed"), t), t("live.restart.done"), t("live.busy.restarting"))} disabled={busy} className={buttonClass}>
              {t("live.action.restart")}
            </button>
            <button onClick={() => setDialog("goLive")} disabled={busy} className={buttonClass}>
              {t("live.action.goLive")}
            </button>
            {overview.videoSettings && (
              <button
                onClick={() =>
                  void busyAction.run(t("live.videoApply.previewing"), async () => {
                    setError(null);
                    try {
                      setApplyPreview(await requestJson<VideoApplyPreview & { liveWritesEnabled: boolean }>(`${base}/apply-video-settings`, undefined, t("live.actionFailed"), t));
                      setDialog("applyVideo");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : t("live.actionFailed"));
                    }
                  })
                }
                disabled={busy}
                className={buttonClass}
              >
                {t("live.action.applyVideo")}
              </button>
            )}
          </>
        )}
      </div>
      {on && overview.videoSettings && <VideoApplyStatus overview={overview} />}
      {!on && overview.rotation.length === 0 && <p className="text-xs text-zinc-500">{t("live.start.needRotation")}</p>}
      {!on && overview.rotation.length > 0 && !settings.title.trim() && <p className="text-xs text-zinc-500">{t("live.start.needTitle")}</p>}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />

      {dialog === "applyVideo" && applyPreview && (
        <ConfirmDialog
          title={t("live.videoApply.title")}
          description={t("live.videoApply.description")}
          confirmLabel={t("live.action.applyVideo")}
          confirmDisabled={!applyPreview.liveWritesEnabled}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(() => requestJson(`${base}/apply-video-settings`, json("POST", {}), t("live.actionFailed"), t), t("live.videoApply.done"), t("live.videoApply.applying"))}
        >
          <VideoApplyList preview={applyPreview} />
          {!applyPreview.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.liveWritesOff")}</p>}
        </ConfirmDialog>
      )}
      {dialog === "start" && preview && (
        <ConfirmDialog
          title={t("live.start.title")}
          description={t("live.start.description")}
          confirmLabel={t("live.action.start")}
          // BL-186: unusable saved settings refuse Start on the server before any call -- the dialog does not offer it.
          confirmDisabled={!preview.liveWritesEnabled || Boolean(preview.videoSettingsProblem)}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(() => requestJson(`${base}/start`, json("POST", {}), t("live.actionFailed"), t), t("live.start.done"), t("live.busy.starting"))}
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-zinc-500">{t("live.field.title")}</dt>
            <dd className="text-zinc-200">{settings.title}</dd>
            <dt className="text-zinc-500">{t("live.field.description")}</dt>
            {/* A stream description can be thousands of characters: about 8 lines here, the rest scrolls in place. */}
            <dd className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-zinc-200">
              {settings.description || "—"}
            </dd>
            <dt className="text-zinc-500">{t("live.field.privacy")}</dt>
            <dd className="text-zinc-200">{t(PRIVACY_KEYS[settings.privacyStatus])}</dd>
            <dt className="text-zinc-500">{t("live.field.madeForKids")}</dt>
            <dd className="text-zinc-200">{settings.madeForKids ? t("live.yes") : t("live.no")}</dd>
            <dt className="text-zinc-500">{t("live.start.autoStop")}</dt>
            <dd className="text-zinc-200">{t("live.start.autoStopValue")}</dd>
            <dt className="text-zinc-500">{t("live.start.recording")}</dt>
            <dd className="text-zinc-200">{t("live.start.recordingValue")}</dd>
            {preview.broadcast?.settings && (
              <>
                <dt className="text-zinc-500">{t("live.video.field.latency")}</dt>
                <dd className="text-zinc-200">{t(LATENCY_KEYS[preview.broadcast.settings.latencyPreference])}</dd>
                <dt className="text-zinc-500">{t("live.video.field.dvr")}</dt>
                <dd className="text-zinc-200">{preview.broadcast.settings.enableDvr ? t("live.yes") : t("live.no")}</dd>
                <dt className="text-zinc-500">{t("live.video.field.embed")}</dt>
                <dd className="text-zinc-200">{preview.broadcast.settings.enableEmbed ? t("live.yes") : t("live.no")}</dd>
                <dt className="text-zinc-500">{t("live.video.field.captions")}</dt>
                <dd className="text-zinc-200">{t("live.video.captionsOff")}</dd>
              </>
            )}
            <dt className="text-zinc-500">{t("live.start.units")}</dt>
            <dd className="text-zinc-200">{t("live.start.unitsValue", { units: String(preview.units) })}</dd>
          </dl>
          {!preview.broadcast?.settings && !preview.videoSettingsProblem && <p className="text-xs text-zinc-400">{t("live.start.broadcastDefaults")}</p>}
          {preview.videoSettings && <StartVideoSettingsSummary settings={preview.videoSettings} apply={preview.videoSettingsApply ?? null} />}
          {preview.videoSettingsProblem && <p className="text-xs text-amber-300">{t("live.video.problem", { problem: preview.videoSettingsProblem })}</p>}
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
              preview?.liveWritesEnabled ? t("live.stop.done") : t("live.stop.encoderOnlyDone"),
              t("live.busy.stopping")
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
          onConfirm={() => void run(() => requestJson(`${base}/go-live`, json("POST", {}), t("live.actionFailed"), t), t("live.goLive.done"), t("live.busy.goingLive"))}
        >
          {!preview?.liveWritesEnabled && <p className="text-xs text-amber-300">{t("live.liveWritesOff")}</p>}
        </ConfirmDialog>
      )}
      <BusyOverlay state={busyAction.overlay} />
    </div>
  );
}

const LATENCY_KEYS: Record<LiveLatency, UiTextKey> = {
  normal: "live.video.latency.normal",
  low: "live.video.latency.low",
  ultraLow: "live.video.latency.ultraLow",
};

/** BL-186 stage 3: the failed steps of an application, in words («Обложка: …; Плейлист «Radio»: …»). */
function failedStepsText(t: ReturnType<typeof useT>, steps: VideoApplyStep[]): string {
  return steps
    .filter((s) => !s.ok)
    .map((s) => `${stepLabel(t, s.step)}: ${s.error ?? "—"}`)
    .join("; ");
}

function stepLabel(t: ReturnType<typeof useT>, step: string): string {
  if (step === "fields") return t("live.videoApply.step.fields");
  if (step === "thumbnail") return t("live.videoApply.step.thumbnail");
  if (step === "localizations") return t("live.videoApply.step.localizations");
  return t("live.videoApply.step.playlist", { id: step.replace(/^playlist:/, "") });
}

/** BL-186 stage 3: what an application sends -- the dry run's list (Start dialog and «Применить снова»). */
function VideoApplyList({ preview }: { preview: VideoApplyPreview }) {
  const t = useT();
  const fields = Object.keys(preview.patch).map((field) => {
    const key = `live.videoApply.field.${field}` as UiTextKey;
    const value = preview.patch[field];
    return `${t(key)}: ${Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? t("live.yes") : t("live.no")) : String(value)}`;
  });
  return (
    <div className="space-y-1 text-xs text-zinc-300">
      <p className="text-zinc-400">{t("live.videoApply.sends")}</p>
      <ul className="list-inside list-disc space-y-0.5">
        <li>{t("live.videoApply.step.fields")}: {fields.join("; ")}</li>
        {preview.localizations && preview.localizations.length > 0 && <li>{t("live.videoApply.step.localizationsList", { languages: preview.localizations.join(", ") })}</li>}
        {preview.thumbnail && <li>{t("live.videoApply.step.thumbnail")}</li>}
        {preview.playlists.map((p) => (
          <li key={p.id}>{t("live.videoApply.step.playlistNamed", { title: p.title || p.id })}</li>
        ))}
      </ul>
      <p className="text-zinc-500">{t("live.videoApply.units", { units: String(preview.units) })}</p>
    </div>
  );
}

/**
 * BL-186 stage 3: whether the saved video settings reached the running broadcast -- read from the stream's own events (the last
 * application for this broadcast), with the failed steps in words. «Применить снова» repeats it.
 */
function VideoApplyStatus({ overview }: { overview: Overview }) {
  const t = useT();
  const broadcastId = overview.stream?.broadcastId ?? null;
  const last = overview.videoSettingsLast && overview.videoSettingsLast.detail.broadcastId === broadcastId ? overview.videoSettingsLast : null;
  if (!last) return <p className="text-xs text-zinc-400">{t("live.videoApply.pending")}</p>;
  const detail = last.detail as unknown as VideoApplyResult;
  if (detail.notApplied) return <p className="text-xs text-amber-300">{t("live.videoApply.unavailable")}</p>;
  return detail.ok ? (
    <p className="text-xs text-emerald-300">{t("live.videoApply.ok", { at: new Date(last.at).toLocaleString(t.language) })}</p>
  ) : (
    <p className="text-xs text-amber-300">{t("live.videoApply.someFailed", { steps: failedStepsText(t, detail.steps) })}</p>
  );
}

/** BL-186: the saved video-level settings in the Start dialog; stage 3: sent to the broadcast's video right after Start. */
function StartVideoSettingsSummary({ settings, apply }: { settings: Omit<LiveVideoSettings, "broadcast">; apply: VideoApplyPreview | null }) {
  const t = useT();
  const marks = [
    settings.containsSyntheticMedia && t("live.video.field.synthetic"),
    settings.paidProductPlacement && t("live.video.field.paidPromotion"),
  ].filter(Boolean);
  return (
    <div className="space-y-1 rounded-lg border border-zinc-800 p-2 text-xs">
      <p className="text-zinc-300">{t("live.start.videoSettingsTitle")}</p>
      {apply ? (
        <p className="text-zinc-400">{t("live.start.videoSettingsSent", { units: String(apply.units) })}</p>
      ) : (
        <p className="text-amber-300">{t("live.videoApply.unavailable")}</p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-500">{t("live.video.field.tags")}</dt>
        <dd className="text-zinc-200">{settings.tags.length > 0 ? settings.tags.join(", ") : "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.field.category")}</dt>
        <dd className="text-zinc-200">{settings.categoryId ? t(`publishingSettings.category.${settings.categoryId}` as UiTextKey) : "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.field.defaultLanguage")}</dt>
        {/* Owner msg 3153: the channel's baseline, as sent (the stream's own field is not used). */}
        <dd className="text-zinc-200">{typeof apply?.patch.defaultLanguage === "string" ? apply.patch.defaultLanguage : "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.field.audioLanguage")}</dt>
        <dd className="text-zinc-200">{settings.defaultAudioLanguage ?? "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.section.marks")}</dt>
        <dd className="text-zinc-200">{marks.length > 0 ? marks.join(", ") : "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.section.playlists")}</dt>
        <dd className="text-zinc-200">{settings.playlists.length > 0 ? settings.playlists.map((p) => p.title || p.id).join(", ") : "—"}</dd>
        <dt className="text-zinc-500">{t("live.video.section.thumbnail")}</dt>
        <dd className="text-zinc-200">{settings.thumbnail ? t("live.yes") : t("live.no")}</dd>
        <dt className="text-zinc-500">{t("live.videoApply.step.localizations")}</dt>
        <dd className="text-zinc-200">{apply?.localizations && apply.localizations.length > 0 ? apply.localizations.join(", ") : "—"}</dd>
      </dl>
    </div>
  );
}

function SettingsCard({ overview, base, onChanged }: { overview: Overview; base: string; onChanged: () => Promise<void> }) {
  const t = useT();
  const saved = overview.stream?.settings ?? EMPTY_SETTINGS;
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<Settings>(saved);
  // BL-195 stage C: saving the settings is local (its button says it is working); editing the stream on air writes to YouTube
  // and runs behind the blocking window.
  const busyAction = useBusyAction();
  const [saving, setSaving] = useState(false);
  const [savedSignal, setSavedSignal] = useState(0);
  const busy = busyAction.busy || saving;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editPreview, setEditPreview] = useState<{ before: { title: string; description: string; privacyStatus: Privacy }; after: { title: string; description: string; privacyStatus: Privacy } } | null>(null);

  // When the SAVED values change (each poll builds a new object), only the fields that changed are taken over: an unsaved
  // edit of another field stays (independent review).
  const previousSaved = useRef(savedKey);
  useEffect(() => {
    const before = JSON.parse(previousSaved.current) as Settings;
    const after = JSON.parse(savedKey) as Settings;
    previousSaved.current = savedKey;
    setDraft((current) => {
      const next = { ...current } as Record<keyof Settings, unknown>;
      for (const key of Object.keys(after) as Array<keyof Settings>) if (before[key] !== after[key]) next[key] = after[key];
      return next as Settings;
    });
  }, [savedKey]);

  // BL-233: the stream's own bitrate as typed (text, never a native number widget); empty = this computer's setting.
  const [bitrateText, setBitrateText] = useState(saved.bitrateKbps === null ? "" : String(saved.bitrateKbps));
  const savedBitrate = saved.bitrateKbps;
  useEffect(() => setBitrateText(savedBitrate === null ? "" : String(savedBitrate)), [savedBitrate]);
  const bitrateValid = bitrateText.trim() === "" || (/^\d{4,5}$/.test(bitrateText.trim()) && Number(bitrateText) >= 1000 && Number(bitrateText) <= 12000);
  const changeBitrate = (text: string) => {
    setBitrateText(text);
    const trimmed = text.trim();
    if (trimmed === "") setDraft((current) => ({ ...current, bitrateKbps: null }));
    else if (/^\d{4,5}$/.test(trimmed) && Number(trimmed) >= 1000 && Number(trimmed) <= 12000) setDraft((current) => ({ ...current, bitrateKbps: Number(trimmed) }));
  };

  const dirty = JSON.stringify(draft) !== savedKey;
  const valid = draft.title.trim().length >= 1 && draft.title.length <= 100 && draft.description.length <= 5000 && bitrateValid;
  const onAir = overview.stream?.intent === "on" && !!overview.stream.broadcastId;

  /** `working`: the blocking window's text (a YouTube write); without it the save button shows it is working. */
  async function run(action: () => Promise<unknown>, done: string, working?: string) {
    setError(null);
    setNotice(null);
    const go = async () => {
      try {
        await action();
        setNotice(done);
        if (!working) setSavedSignal((n) => n + 1);
        await onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("live.actionFailed"));
      }
    };
    if (working) return busyAction.run(working, go);
    setSaving(true);
    try {
      await go();
    } finally {
      setSaving(false);
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
        <label className="flex items-center gap-2">
          <span className="text-zinc-400">{t("live.field.bitrate")}</span>
          <input
            type="text"
            inputMode="numeric"
            value={bitrateText}
            onChange={(e) => changeBitrate(e.target.value)}
            placeholder={t("live.field.bitratePlaceholder")}
            disabled={busy}
            aria-label={t("live.field.bitrate")}
            className={`${inputClass} w-44 ${bitrateValid ? "" : "border-red-700"}`}
          />
        </label>
      </div>
      <p className="text-xs text-zinc-500">{bitrateValid ? t("live.field.bitrateHint") : <span className="text-red-400">{t("live.field.bitrateInvalid")}</span>}</p>
      <div className="flex flex-wrap gap-2">
        <ActionButton busy={saving} busyLabel={t("common.saving")} doneSignal={savedSignal} onClick={() => void run(() => requestJson(`${base}/settings`, json("PUT", draft), t("settings.saveFailed"), t), t("live.settings.saved"))} disabled={busy || !dirty || !valid} className={primaryClass}>
          {onAir ? t("live.settings.saveNext") : t("live.settings.save")}
        </ActionButton>
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
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
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
            void run(() => requestJson(`${base}/edit`, json("POST", { patch, expected }), t("live.actionFailed"), t), t("live.edit.done"), t("live.busy.editing"));
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
      <BusyOverlay state={busyAction.overlay} />
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
  const [pickerOpen, setPickerOpen] = useState(false);
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
        <button onClick={() => setPickerOpen(true)} disabled={busy} className={primaryClass}>
          {t("live.picker.open")}
        </button>
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">{t("live.picker.manual")}</summary>
          <div className="mt-2 space-y-2">
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
        </details>
      </div>
      {pickerOpen && <LiveStreamAddVideosDialog base={base} rotationIds={inRotation} onClose={() => setPickerOpen(false)} onAdded={onChanged} />}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
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
  youtube_status: "live.event.youtubeStatus",
  encoder_replay_end: "live.event.replayEnd",
  encoder_starting: "live.event.encoderStart",
  stream_forgotten: "live.event.streamForgotten",
  settings_saved: "live.event.settingsSaved",
  rotation_add: "live.event.rotationAdd",
  rotation_remove: "live.event.rotationRemove",
  rotation_reorder: "live.event.rotationReorder",
  guard_refused: "live.event.guardRefused",
  guard_override: "live.event.guardOverride",
  guard_override_cleared: "live.event.guardOverrideCleared",
  sources_set: "live.event.sourcesSet",
  live_segment_switched: "live.event.segmentSwitched",
  viewer_sample_failed: "live.event.viewerSampleFailed",
  live_segment_switch_failed: "live.event.segmentSwitchFailed",
  live_segment_recovered: "live.event.segmentRecovered",
  live_segment_cap_reached: "live.event.segmentCapReached",
  live_segment_recording_added: "live.event.segmentRecordingAdded",
  live_segment_recording_not_added: "live.event.segmentRecordingNotAdded",
  segments_saved: "live.event.segmentsSaved",
  live_segment_switch_cancelled: "live.event.segmentSwitchCancelled",
  live_segment_cleaned_up: "live.event.segmentCleanedUp",
  live_segment_end_old_retrying: "live.event.segmentEndOldRetrying",
  live_segment_cleanup_retry: "live.event.segmentCleanupRetry",
  recording_required: "live.event.recordingRequired",
  video_settings_step: "live.event.videoSettingsStep",
  video_settings_applied: "live.event.videoSettingsApplied",
  localizations_saved: "live.event.localizationsSaved",
  upload_held: "live.event.uploadHeld",
  upload_released: "live.event.uploadReleased",
};

const UPLOAD_RELEASE_KEYS: Record<string, UiTextKey> = {
  recovered: "live.uploadRelease.recovered",
  ceiling: "live.uploadRelease.ceiling",
  no_stream: "live.uploadRelease.no_stream",
  guard_off: "live.uploadRelease.guard_off",
  stream_off: "live.uploadRelease.stream_off",
  no_upload: "live.uploadRelease.no_upload",
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
            const what =
              event.kind === "video_settings_step" && typeof detail.step === "string"
                ? `${stepLabel(t, detail.step)} · ${detail.ok ? t("live.yes") : String(detail.error ?? "—")}`
                : event.kind === "localizations_saved" && Array.isArray(detail.languages)
                ? detail.languages.join(", ") || "—"
                : event.kind === "upload_held" && typeof detail.speed === "number"
                ? `${detail.speed.toFixed(3)}×`
                : event.kind === "upload_released" && typeof detail.releaseReason === "string"
                ? UPLOAD_RELEASE_KEYS[detail.releaseReason] ? t(UPLOAD_RELEASE_KEYS[detail.releaseReason]) : detail.releaseReason
                : typeof detail.method === "string"
                ? detail.method
                : typeof detail.videoId === "string"
                  ? detail.videoId
                  : typeof detail.cause === "string"
                    ? causeText(t, detail.cause)
                    : typeof detail.reason === "string"
                      ? causeText(t, detail.reason)
                      : typeof detail.lifeCycleStatus === "string"
                        ? detail.lifeCycleStatus
                        : "";
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
