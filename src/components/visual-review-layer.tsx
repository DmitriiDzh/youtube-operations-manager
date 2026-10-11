"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useDialogFocus } from "./use-dialog-focus";
import type { PlanMarkerRegion, PlanPickMark, PlanValidatorVerdict } from "@/lib/generation-plans/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { MediaImageViewer, type ImageViewerHandle, type ViewerPin } from "./media-image-viewer";
import { MediaVideoPlayer, type VideoMarker, type VideoPlayerHandle } from "./media-video-player";
import { useUiText } from "./ui-text-provider";
import { attemptLabel, FIT, groupByItem, type ViewState } from "./visual-review-model";

// BL-175 (FO-REQ-0018 §B, VISUAL_REVIEW_PLAN.md §2.9): the whole-window layer of the visual review -- the grid of attempts (the
// item's or the wave's, grouped by item), the loupe (one attempt at full size) and compare (two side by side, linked zoom and
// pan, or linked playback). The screen owns every decision and the keyboard; the layer shows and reports clicks.

export type LayerMode = "grid" | "loupe" | "compare";

export type LayerEntry = {
  key: string;
  itemKey: string;
  attemptRef: string;
  seed: number | null;
  media: "image" | "video";
  picked?: PlanPickMark;
  pickSent?: boolean;
  notChosen?: boolean;
  verdict: { result: string; rating: number | null } | null;
  validator: PlanValidatorVerdict | null;
  /** The file itself (audition route) and, for an image, its small preview. */
  fullSrc: string;
  previewSrc: string | null;
  fps: number | null;
  pins: ViewerPin[];
  markers: VideoMarker[];
};

export type LayerHandle = { zoom(): void; frame(direction: 1 | -1): void; togglePlay(): void; seekBy(seconds: number): void };

type Props = {
  mode: LayerMode;
  scope: "item" | "wave";
  onScope: (scope: "item" | "wave") => void;
  entries: LayerEntry[];
  currentKey: string | null;
  compareKey: string | null;
  blind: boolean;
  shortKey: (itemKey: string) => string;
  /** Each item's picks so far and how many it takes. */
  itemPicks: (itemKey: string) => { picked: number; target: number; noneFits: boolean };
  /** Why an attempt cannot be picked (null = it can). */
  pickBlocked: (entry: LayerEntry) => string | null;
  busy: boolean;
  onSelect: (entry: LayerEntry) => void;
  onToggleCompare: (entry: LayerEntry) => void;
  onMode: (mode: LayerMode) => void;
  onPick: (entry: LayerEntry) => void;
  /** "None of these fits" for an item (the screen asks for the note). */
  onNoneFits?: (itemKey: string) => void;
  onClose: () => void;
  onAddPin?: (region: PlanMarkerRegion, atSeconds: number) => void;
  /** A line under the header (a message from the last action). */
  message?: { tone: "ok" | "error"; text: string } | null;
};

export const VisualReviewLayer = forwardRef<LayerHandle, Props>(function VisualReviewLayer(props, ref) {
  const { t } = useUiText();
  const { mode, entries, currentKey, compareKey } = props;
  const current = entries.find((e) => e.key === currentKey) ?? null;
  const other = entries.find((e) => e.key === compareKey) ?? null;
  const pair = current && other && current.key !== other.key ? [current, other] : null;
  const image = useRef<ImageViewerHandle | null>(null);
  const videos = useRef<Array<VideoPlayerHandle | null>>([null, null]);
  const [linked, setLinked] = useState<ViewState>(FIT);
  // Review round 1: the layer is a dialog -- it takes the focus, keeps Tab inside and gives the focus back when it closes.
  const root = useRef<HTMLDivElement | null>(null);
  useDialogFocus(root, { initial: "container" });

  // Review round 2: in compare the two clips start together -- each waits until both are loaded, then both play from the start.
  const ready = useRef(new Set<string>());
  useEffect(() => {
    ready.current.clear();
  }, [mode, current?.key, other?.key]);
  const onClipReady = (key: string) => {
    ready.current.add(key);
    if (mode === "compare" && pair && pair.every((e) => ready.current.has(e.key))) for (const v of videos.current) v?.seekTo(0, "play");
  };

  // Compare: the first clip leads -- every key and button drives it, and the other one follows its moves (`onUserSeek`).
  useImperativeHandle(ref, () => ({
    zoom() {
      if (mode === "loupe") image.current?.toggleActual();
      // Compare: both images follow one view -- fit, or 100 % at their centres.
      if (mode === "compare") setLinked((v) => (v.fit ? { fit: false, scale: 1, cx: 0.5, cy: 0.5 } : FIT));
    },
    frame(direction) {
      videos.current[0]?.stepFrame(direction);
    },
    togglePlay() {
      const lead = videos.current[0];
      if (!lead) return;
      const playing = lead.isPlaying();
      lead.togglePlay();
      if (mode === "compare") videos.current[1]?.seekTo(lead.currentTime(), playing ? "pause" : "play");
    },
    seekBy(seconds) {
      videos.current[0]?.seekBy(seconds);
    },
  }));

  const pickButton = (entry: LayerEntry, large = false) => {
    const blocked = props.pickBlocked(entry);
    return (
      <button
        type="button"
        disabled={props.busy || (blocked !== null && !entry.picked)}
        title={entry.picked ? t("review.pick.withdrawHint") : (blocked ?? undefined)}
        onClick={(event) => {
          event.stopPropagation();
          props.onPick(entry);
        }}
        className={`rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${large ? "px-4 py-2 text-sm" : "px-2.5 py-1 text-xs"} ${entry.picked ? "border-amber-400 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30" : "border-zinc-600 bg-zinc-900/90 text-zinc-100 hover:border-amber-400"}`}
      >
        {entry.picked ? `★ ${t("review.pick.picked")}` : t("review.pick.pick")}
        {/* ui-text-ignore: a keyboard key */}
        {large ? <kbd className="ml-2 rounded border border-current/40 px-1 text-[11px] opacity-70">S</kbd> : null}
      </button>
    );
  };

  const status = (entry: LayerEntry) => (
    <span className="flex flex-wrap items-center gap-1">
      {entry.picked ? (
        <span className="rounded-full bg-amber-500/25 px-1.5 text-[11px] text-amber-200" title={t("review.pick.by", { device: entry.picked.device, time: formatDisplayDateTime(entry.picked.at) })}>
          ★{entry.pickSent ? ` ${t("review.pick.sent")}` : ""}
        </span>
      ) : null}
      {entry.verdict ? (
        <span className={`rounded-full px-1.5 text-[11px] ${entry.verdict.result === "accepted" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}>
          {entry.verdict.result === "accepted" ? "✓" : "✗"}
          {entry.verdict.rating !== null ? ` ${entry.verdict.rating}/10` : ""}
        </span>
      ) : null}
      {entry.notChosen ? <span className="rounded-full bg-zinc-700/80 px-1.5 text-[11px] text-zinc-300">{t("review.pick.notChosen")}</span> : null}
      {!props.blind && entry.validator !== null ? <span className={`text-[11px] ${entry.validator === "rejected" ? "text-amber-400" : "text-emerald-500/80"}`}>{entry.validator === "rejected" ? t("review.queue.autoFailed") : t("review.queue.autoPassed")}</span> : null}
    </span>
  );

  const viewer = (entry: LayerEntry, slot: 0 | 1, className: string, shared?: boolean) =>
    entry.media === "image" ? (
      <MediaImageViewer
        key={entry.key}
        ref={slot === 0 && !shared ? image : undefined}
        src={entry.fullSrc}
        pins={entry.pins}
        onAddPin={slot === 0 && entry.key === currentKey && props.onAddPin ? (region) => props.onAddPin?.(region, 0) : undefined}
        className={className}
        wheelZoom="always"
        {...(shared ? { view: linked, onViewChange: setLinked } : {})}
      />
    ) : (
      <MediaVideoPlayer
        key={entry.key}
        ref={(h) => {
          videos.current[slot] = h;
        }}
        src={entry.fullSrc}
        markers={entry.markers}
        fps={entry.fps}
        className={className}
        compact={shared}
        onAddPin={slot === 0 && entry.key === currentKey && props.onAddPin ? props.onAddPin : undefined}
        // Compare: a seek in one clip moves the other to the same moment and the same state (playing or paused), without it
        // seeking back (review round 1); so do play and pause asked for in either clip (review round 2). The loop range stays
        // the clip's own.
        onUserSeek={shared ? (seconds, playing) => videos.current[slot === 0 ? 1 : 0]?.seekTo(seconds, playing ? "play" : "pause") : undefined}
        onUserPlay={shared ? (playing, seconds) => videos.current[slot === 0 ? 1 : 0]?.seekTo(seconds, playing ? "play" : "pause") : undefined}
        autoPlay={!shared}
        onReady={shared ? () => onClipReady(entry.key) : undefined}
      />
    );

  const groups = groupByItem(entries);
  const modeButton = (m: LayerMode, label: string, key: string, disabled = false) => (
    <button type="button" disabled={disabled} onClick={() => props.onMode(m)} aria-pressed={mode === m} className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${mode === m ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}>
      {label}
      {/* ui-text-ignore: a keyboard key */}
      <kbd className="ml-1.5 text-[10px] text-zinc-500">{key}</kbd>
    </button>
  );

  return (
    <div ref={root} tabIndex={-1} className="fixed inset-0 z-50 flex flex-col bg-zinc-950/[0.97] outline-none" role="dialog" aria-modal="true" aria-label={t("review.layer.label")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <span className="inline-flex gap-1 rounded-lg bg-zinc-900 p-1">
          {modeButton("grid", t("review.layer.grid"), "G")}
          {/* ui-text-ignore: a keyboard key */}
          {modeButton("loupe", t("review.layer.loupe"), "Enter", !current)}
          {modeButton("compare", t("review.layer.compare"), "C", !pair)}
        </span>
        {mode === "grid" && (
          <span className="inline-flex gap-1 rounded-lg bg-zinc-900 p-1" role="group" aria-label={t("review.layer.scope")}>
            {(["item", "wave"] as const).map((s) => (
              <button key={s} type="button" onClick={() => props.onScope(s)} aria-pressed={props.scope === s} className={`rounded-md px-2.5 py-1 text-xs ${props.scope === s ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
                {s === "item" ? t("review.layer.scopeItem") : t("review.layer.scopeWave")}
              </button>
            ))}
          </span>
        )}
        <span className="text-xs text-zinc-500">{mode === "grid" ? t("review.layer.gridHint") : mode === "compare" ? t("review.layer.compareHint") : t("review.layer.loupeHint")}</span>
        <button type="button" onClick={props.onClose} className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
          {t("review.layer.close")}
          {/* ui-text-ignore: a keyboard key */}
          <kbd className="ml-1.5 text-[10px] text-zinc-500">Esc</kbd>
        </button>
      </div>
      {props.message && <p className={`px-4 py-1 text-xs ${props.message.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{props.message.text}</p>}

      {mode === "grid" && (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {groups.map((group) => {
            const counts = props.itemPicks(group.itemKey);
            return (
              <section key={group.itemKey} className="space-y-2">
                <h3 className="flex flex-wrap items-baseline gap-3 text-sm">
                  <span className="font-mono font-semibold text-white">{props.shortKey(group.itemKey)}</span>
                  <span className="text-xs text-zinc-400">{counts.noneFits ? t("review.noneFits.marked") : t("review.pick.count", { picked: counts.picked, target: counts.target })}</span>
                  {props.onNoneFits && !counts.noneFits ? (
                    <button type="button" disabled={props.busy} onClick={() => props.onNoneFits?.(group.itemKey)} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                      {t("review.noneFits.button")}
                    </button>
                  ) : null}
                </h3>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                  {group.entries.map((entry) => {
                    const isCurrent = entry.key === currentKey;
                    const isCompared = entry.key === compareKey;
                    return (
                      <li key={entry.key}>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-pressed={isCurrent}
                          onClick={(event) => (event.shiftKey || event.metaKey || event.ctrlKey ? props.onToggleCompare(entry) : props.onSelect(entry))}
                          onDoubleClick={() => {
                            props.onSelect(entry);
                            props.onMode("loupe");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === " ") {
                              event.preventDefault();
                              props.onSelect(entry);
                            } else if (event.key === "Enter") {
                              // §B: Enter (or a double click) opens the attempt at full size.
                              event.preventDefault();
                              event.stopPropagation();
                              props.onSelect(entry);
                              props.onMode("loupe");
                            }
                          }}
                          className={`group relative overflow-hidden rounded-lg border bg-zinc-900 ${entry.notChosen ? "opacity-60" : ""} ${isCurrent ? "border-violet-400 ring-2 ring-violet-400/60" : isCompared ? "border-sky-400 ring-2 ring-sky-400/50" : entry.picked ? "border-amber-400/80" : "border-zinc-800 hover:border-zinc-600"}`}
                        >
                          <div className="flex h-44 items-center justify-center bg-black">
                            {entry.media === "image" ? (
                              // eslint-disable-next-line @next/next/no-img-element -- a local preview of this computer's file
                              <img src={entry.previewSrc ?? entry.fullSrc} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" />
                            ) : (
                              <video
                                src={entry.fullSrc}
                                preload="metadata"
                                muted
                                playsInline
                                loop
                                className="max-h-full max-w-full object-contain"
                                // §B: a clip plays muted while the mouse is over it; only the hovered one ever plays.
                                onMouseEnter={(event) => void event.currentTarget.play().catch(() => undefined)}
                                onMouseLeave={(event) => {
                                  event.currentTarget.pause();
                                  event.currentTarget.currentTime = 0;
                                }}
                              />
                            )}
                          </div>
                          {/* The state over the picture, so the name and the pick button keep the footer to themselves. */}
                          <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/70 px-1 py-0.5">{status(entry)}</span>
                          <div className="flex items-center gap-2 px-2 py-1.5">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={entry.attemptRef}>
                              {attemptLabel(entry)}
                            </span>
                            <span className="shrink-0">{pickButton(entry)}</span>
                          </div>
                          {isCompared ? <span className="absolute left-2 top-2 rounded bg-sky-500/80 px-1.5 text-[11px] text-white">{t("review.layer.compareMark")}</span> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {mode === "loupe" && current && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono font-semibold text-white">{props.shortKey(current.itemKey)}</span>
            <span className="font-mono text-xs text-zinc-400">{attemptLabel(current)}</span>
            {status(current)}
            <span className="ml-auto">{pickButton(current, true)}</span>
          </div>
          <div className="min-h-0 flex-1">{viewer(current, 0, "h-[calc(100vh-11rem)]")}</div>
        </div>
      )}

      {mode === "compare" && pair && (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-4">
          {pair.map((entry, slot) => (
            <div key={entry.key} className="flex min-h-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold text-white">{props.shortKey(entry.itemKey)}</span>
                <span className="font-mono text-xs text-zinc-400">{attemptLabel(entry)}</span>
                {status(entry)}
                <span className="ml-auto">{pickButton(entry)}</span>
              </div>
              {viewer(entry, slot as 0 | 1, "h-[calc(100vh-12rem)]", true)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
