"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@/lib/ui-text";
import type { UiTextKey } from "@/lib/ui-text";
import type { LibrarySegmentView, LiveSourceMode, SelectedSegmentView } from "@/lib/live-streams";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { StatusNotice } from "./busy-feedback";
import { LoadingIndicator } from "./operation-progress";
import { useDialogFocus } from "./use-dialog-focus";
import { useT } from "./ui-text-provider";

// BL-234 (FO-REQ-0048 as changed by the owner, msgs 3792/3793/3795; ADR 0056): what the stream plays -- the rotation of published
// videos or the owner's selection from the channel's segment library. The switch is the owner's (an agent cannot reach it) and applies
// at the next pass, or at once with «Перезапустить энкодер». In segments mode the owner picks and orders segments instead of videos;
// removing one only takes it out of the stream -- the app never deletes a library file.

type LibraryResult = { available: boolean; reason: string | null; message: string | null; folder: string; segments: LibrarySegmentView[]; skipped: number };
type AddResult = { added: SelectedSegmentView[]; refused: Array<{ seq: number; reason: string; message: string }> };

const cardClass = "space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

const UNAVAILABLE_KEYS: Record<string, UiTextKey> = {
  workspace_not_configured: "live.library.unavailable.workspace_not_configured",
  workspace_unavailable: "live.library.unavailable.workspace_unavailable",
  library_missing: "live.library.unavailable.library_missing",
};

export const SEGMENT_REFUSAL_KEYS: Record<string, UiTextKey> = {
  not_in_library: "live.library.refusal.not_in_library",
  sidecar_invalid: "live.library.refusal.sidecar_invalid",
  file_unavailable: "live.library.refusal.file_unavailable",
  no_video_stream: "live.library.refusal.no_video_stream",
  audio_unsupported: "live.library.refusal.audio_unsupported",
  duration_unknown: "live.library.refusal.duration_unknown",
};

function minutes(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const posterUrl = (base: string, seq: number) => `${base}/library/${seq}/poster`;

function Poster({ base, seq, show }: { base: string; seq: number; show: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!show || failed) return <div className="h-[54px] w-24 shrink-0 rounded bg-zinc-800" />;
  // eslint-disable-next-line @next/next/no-img-element -- the segment's poster from the channel folder, served by the app
  return <img src={posterUrl(base, seq)} alt="" loading="lazy" onError={() => setFailed(true)} className="h-[54px] w-24 shrink-0 rounded object-cover" />;
}

/** The owner's switch between the two sources, with a dialog saying when it applies. */
export function LiveStreamSourceSwitch({
  base,
  mode,
  hasStream,
  segmentsReady,
  videosReady,
  onChanged,
}: {
  base: string;
  mode: LiveSourceMode;
  hasStream: boolean;
  /** A selected segment passed its check: only then can the stream be switched to segments (the server checks it too). */
  segmentsReady: boolean;
  /** A rotation video passed its check (or has the owner's override): only then back to videos (the server checks it too). */
  videosReady: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [target, setTarget] = useState<LiveSourceMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const options: Array<{ mode: LiveSourceMode; key: UiTextKey }> = [
    { mode: "videos", key: "live.source.videos" },
    { mode: "segments", key: "live.source.segments" },
  ];
  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("live.source.title")}
        <InfoTooltip>{t("live.source.info")}</InfoTooltip>
      </h3>
      <div role="radiogroup" aria-label={t("live.source.title")} className="inline-flex rounded-lg border border-zinc-700 p-0.5">
        {options.map((option) => (
          <button
            key={option.mode}
            role="radio"
            aria-checked={mode === option.mode}
            onClick={() => option.mode !== mode && setTarget(option.mode)}
            disabled={
              busy ||
              !hasStream ||
              (option.mode === "segments" && mode !== "segments" && !segmentsReady) ||
              (option.mode === "videos" && mode !== "videos" && !videosReady)
            }
            className={`rounded-md px-3 py-1 text-xs ${mode === option.mode ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-300 hover:bg-zinc-800"} disabled:opacity-50`}
          >
            {t(option.key)}
          </button>
        ))}
      </div>
      {!hasStream && <p className="text-xs text-zinc-500">{t("live.source.needSettings")}</p>}
      {hasStream && mode === "videos" && !segmentsReady && <p className="text-xs text-zinc-500">{t("live.source.needSegments")}</p>}
      {hasStream && mode === "segments" && !videosReady && <p className="text-xs text-zinc-500">{t("live.source.needVideos")}</p>}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
      {target && (
        <ConfirmDialog
          title={t(target === "segments" ? "live.source.confirmSegmentsTitle" : "live.source.confirmVideosTitle")}
          description={t("live.source.confirmDescription")}
          confirmLabel={t("live.source.confirm")}
          onCancel={() => setTarget(null)}
          onConfirm={() => {
            const next = target;
            setTarget(null);
            setBusy(true);
            setError(null);
            setNotice(null);
            void requestJson(`${base}/source`, json("PUT", { mode: next }), t("live.actionFailed"), t)
              .then(async () => {
                setNotice(t("live.source.saved"));
                await onChanged();
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : t("live.actionFailed")))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}

/** The stream's selection from the segment library: order, remove (from the stream only), add from the library. */
export function LiveStreamLibraryCard({
  base,
  selection,
  preparing,
  hasStream,
  onChanged,
}: {
  base: string;
  selection: SelectedSegmentView[];
  /** The stream still plays videos: the selection is being prepared for a switch. */
  preparing: boolean;
  hasStream: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const selected = useMemo(() => new Set(selection.map((s) => s.seq)), [selection]);
  const playableMinutes = Math.round(selection.filter((s) => s.check.status === "ok").reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0) / 60);

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
    const seqs = selection.map((s) => s.seq);
    const target = index + delta;
    if (target < 0 || target >= seqs.length) return;
    [seqs[index], seqs[target]] = [seqs[target], seqs[index]];
    void run(() => requestJson(`${base}/library`, json("PUT", { seqs }), t("live.actionFailed"), t), t("live.rotation.reordered"));
  };

  return (
    <div className={cardClass}>
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t(preparing ? "live.library.titlePreparing" : "live.library.title")}
        <InfoTooltip>{t("live.library.info")}</InfoTooltip>
      </h3>
      {preparing && <p className="text-xs text-zinc-400">{t("live.library.preparingHint")}</p>}
      {selection.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("live.library.empty")}</p>
      ) : (
        <>
          <p className="text-xs text-zinc-400">{t("live.library.summary", { n: String(selection.length), minutes: String(playableMinutes) })}</p>
          <ol className="divide-y divide-zinc-800">
            {selection.map((segment, index) => (
              <li key={segment.seq} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="w-6 text-right text-xs text-zinc-500">{index + 1}</span>
                <Poster base={base} seq={segment.seq} show />
                <div className="min-w-0 flex-1">
                  {/* ui-text-ignore: the segment's title from its sidecar (data) */}
                  <p className="truncate text-zinc-100">{segment.title ?? segment.id}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {t("live.library.meta", { seq: segment.id, duration: minutes(segment.durationSeconds), tracks: String(segment.tracks.length) })}
                  </p>
                  {segment.check.status === "refused" && (
                    <p className="text-xs text-amber-300">{t(SEGMENT_REFUSAL_KEYS[segment.check.reason ?? ""] ?? "live.library.refusal.file_unavailable")}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => move(index, -1)} disabled={busy || index === 0} className={buttonClass} aria-label={t("live.rotation.up")}>
                    ↑
                  </button>
                  <button onClick={() => move(index, 1)} disabled={busy || index === selection.length - 1} className={buttonClass} aria-label={t("live.rotation.down")}>
                    ↓
                  </button>
                  <button onClick={() => setRemoveFor(segment.seq)} disabled={busy} className={buttonClass}>
                    {t("live.rotation.remove")}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="border-t border-zinc-800 pt-3">
        <button onClick={() => setDialogOpen(true)} disabled={busy || !hasStream} className={primaryClass}>
          {t("live.library.open")}
        </button>
      </div>
      {dialogOpen && <LiveStreamLibraryDialog base={base} selected={selected} onClose={() => setDialogOpen(false)} onAdded={onChanged} />}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
      {removeFor !== null && (
        <ConfirmDialog
          title={t("live.library.removeTitle")}
          description={t("live.library.removeDescription")}
          confirmLabel={t("live.rotation.remove")}
          onCancel={() => setRemoveFor(null)}
          onConfirm={() => {
            const seq = removeFor;
            setRemoveFor(null);
            void run(() => requestJson(`${base}/library/${seq}`, { method: "DELETE" }, t("live.actionFailed"), t), t("live.rotation.removed"));
          }}
        />
      )}
    </div>
  );
}

/** «Добавить сегменты…»: the library's complete segments to tick; «Добавить N» adds them in the order they were ticked. */
function LiveStreamLibraryDialog({ base, selected, onClose, onAdded }: { base: string; selected: ReadonlySet<number>; onClose: () => void; onAdded: () => Promise<void> }) {
  const t = useT();
  const root = useRef<HTMLDivElement | null>(null);
  useDialogFocus(root);
  const [result, setResult] = useState<LibraryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<AddResult | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await requestJson<LibraryResult>(`${base}/library`, undefined, t("live.loadFailed"), t));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("live.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (seq: number, on: boolean) => setTicked((current) => (on ? [...current.filter((s) => s !== seq), seq] : current.filter((s) => s !== seq)));

  async function add() {
    setAdding(true);
    setAddError(null);
    setOutcome(null);
    try {
      const added = await requestJson<AddResult>(`${base}/library`, json("POST", { seqs: ticked }), t("live.actionFailed"), t);
      setOutcome(added);
      setTicked([]);
      await onAdded();
      await load();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("live.actionFailed"));
    } finally {
      setAdding(false);
    }
  }

  const segments = result?.segments ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
      <div ref={root} role="dialog" aria-modal="true" aria-label={t("live.library.dialogTitle")} tabIndex={-1} className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 p-4">
          <div className="space-y-1">
            <h2 className="text-base font-medium text-zinc-100">{t("live.library.dialogTitle")}</h2>
            <p className="text-xs text-zinc-400">{t("live.library.dialogIntro", { folder: result?.folder ?? "04 Videos/Live Segments" })}</p>
          </div>
          <button onClick={onClose} className={buttonClass}>
            {t("common.close")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {loading && <LoadingIndicator className="py-4 text-sm text-zinc-400" />}
          {loadError && <p className="py-4 text-sm text-red-400">{loadError}</p>}
          {result && !result.available && <p className="py-4 text-sm text-amber-300">{t(UNAVAILABLE_KEYS[result.reason ?? ""] ?? "live.library.unavailable.workspace_unavailable")}</p>}
          {result?.available && segments.length === 0 && <p className="py-4 text-sm text-zinc-500">{t("live.library.none")}</p>}
          {result?.available && result.skipped > 0 && <p className="pt-3 text-xs text-zinc-500">{t("live.library.skipped", { n: String(result.skipped) })}</p>}
          <ul className="divide-y divide-zinc-800">
            {segments.map((segment) => {
              const already = selected.has(segment.seq) || segment.selected;
              const order = ticked.indexOf(segment.seq);
              const id = `library-${segment.seq}`;
              return (
                <li key={segment.seq} className={`flex items-start gap-3 py-2.5 ${already ? "opacity-50" : ""}`}>
                  <input id={id} type="checkbox" checked={already || order >= 0} disabled={already || adding} onChange={(e) => toggle(segment.seq, e.target.checked)} className="mt-3 h-4 w-4 shrink-0 accent-zinc-100" />
                  <label htmlFor={id} className="shrink-0">
                    <Poster base={base} seq={segment.seq} show={segment.poster} />
                  </label>
                  <div className="min-w-0 flex-1 text-sm">
                    <label htmlFor={id} className="block truncate text-zinc-100">
                      {/* ui-text-ignore: the segment's title from its sidecar (data) */}
                      {segment.title ?? segment.id}
                    </label>
                    <p className="text-xs text-zinc-500">
                      {t("live.library.meta", { seq: segment.id, duration: minutes(segment.durationSeconds), tracks: String(segment.tracks.length) })}
                      {already ? ` · ${t("live.library.inStream")}` : order >= 0 ? ` · #${order + 1}` : ""}
                    </p>
                    {segment.tracks.length > 0 && (
                      <details className="text-xs text-zinc-400">
                        <summary className="cursor-pointer hover:text-zinc-200">{t("live.library.tracks")}</summary>
                        <ul className="mt-1 space-y-0.5">
                          {segment.tracks.map((track, i) => (
                            <li key={`${track.startSec}-${i}`}>
                              {/* ui-text-ignore: the track's start and title from the sidecar (data) */}
                              <span className="tabular-nums text-zinc-500">{minutes(track.startSec)}</span> {track.title}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-2 border-t border-zinc-800 p-4">
          {outcome && outcome.refused.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-300">
              {outcome.refused.map((r) => (
                <li key={r.seq}>
                  {/* ui-text-ignore: the segment's id (data) */}
                  {`seg-${String(r.seq).padStart(6, "0")}`} — {t(SEGMENT_REFUSAL_KEYS[r.reason] ?? "live.library.refusal.file_unavailable")}
                </li>
              ))}
            </ul>
          )}
          {outcome && outcome.added.length > 0 && <p className="text-xs text-emerald-300">{t("live.library.added", { n: String(outcome.added.length) })}</p>}
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={buttonClass}>
              {t("common.close")}
            </button>
            <button onClick={() => void add()} disabled={adding || ticked.length === 0} className={primaryClass}>
              {t("live.library.add", { n: String(ticked.length) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
