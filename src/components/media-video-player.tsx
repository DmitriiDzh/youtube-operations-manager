"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PlanMarkerRegion } from "@/lib/generation-plans/contracts";
import { formatPlayerTime } from "./media-review-player";
import { useUiText } from "./ui-text-provider";
import { fitView, frameAt, measuredFps, regionFromDrag, regionToScreen, stepFrame, type ImageBox } from "./visual-review-model";

// BL-175 (FO-REQ-0018 §A/§C, VISUAL_REVIEW_PLAN.md §2.9): one clip of a review -- looped and muted by default, speed 0.25-2, one
// frame back and forward (the row's fps, else measured while it plays, else 1/30 s), a timeline that scrubs under the mouse while
// paused, a dragged range that loops, the markers as ranges on the timeline, and pins on the frame. Shift + drag on the paused
// frame sets a pin. It knows nothing about plans; the screen drives it through the handle like the audio player.

export type VideoMarker = { start: number; end: number | null; label: string | null; tone: "finding" | "mark" | "question"; region?: PlanMarkerRegion };

export type VideoPlayerHandle = {
  togglePlay(): void;
  seekBy(seconds: number): void;
  currentTime(): number;
  pause(): void;
  playFrom(seconds: number): void;
  /** One frame back (-1) or forward (+1); pauses. */
  stepFrame(direction: 1 | -1): void;
};

const RATES = [0.25, 0.5, 1, 2] as const;
const TONE_COLORS = { finding: "bg-red-500/40", mark: "bg-amber-400/50", question: "bg-sky-400/45" } as const;
/** Without a known frame rate a step is 1/30 s. */
const FALLBACK_FPS = 30;
/** A pin of a point marker shows this long after its start. */
const POINT_PIN_SECONDS = 0.5;

export const MediaVideoPlayer = forwardRef<
  VideoPlayerHandle,
  {
    src: string;
    markers: VideoMarker[];
    /** The row's `metrics.fps` (the Operator's number); null = measured here. */
    fps: number | null;
    /** Shift + drag on the paused frame: a pin at this time (absent = no new pins). */
    onAddPin?: (region: PlanMarkerRegion, atSeconds: number) => void;
    onPlayStart?: () => void;
    /** Seeks made here, so a linked player (compare) can follow. */
    onUserSeek?: (seconds: number) => void;
    onPlayingChange?: (playing: boolean) => void;
    className?: string;
    /** Starts muted (the default) -- FO-REQ-0018 §A. */
    startMuted?: boolean;
    compact?: boolean;
  }
>(function MediaVideoPlayer({ src, markers, fps: reportedFps, onAddPin, onPlayStart, onUserSeek, onPlayingChange, className = "h-[48vh]", startMuted = true, compact = false }, ref) {
  const { t } = useUiText();
  const video = useRef<HTMLVideoElement | null>(null);
  const frameBox = useRef<HTMLDivElement | null>(null);
  const timeline = useRef<HTMLDivElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [muted, setMuted] = useState(startMuted);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [box, setBox] = useState<ImageBox | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [measured, setMeasured] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const frameTimes = useRef<number[]>([]);
  const selecting = useRef<{ start: number; moved: boolean } | null>(null);
  const pinDrag = useRef<{ x: number; y: number } | null>(null);
  const [pinDraft, setPinDraft] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const fps = reportedFps ?? measured;

  useEffect(() => {
    const el = frameBox.current;
    if (!el) return;
    const measure = () => setFrame({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The playhead follows every presented frame (rAF while playing), and the loop range holds playback inside it.
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        if (range && (v.currentTime >= range.end || v.currentTime < range.start - 0.05)) v.currentTime = range.start;
        setTime(v.currentTime);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, range]);

  // The frame rate when the row gives none: the presented frames' media times while it plays.
  useEffect(() => {
    const v = video.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (id: number) => void }) | null;
    if (!v || reportedFps !== null || measured !== null || !playing || typeof v.requestVideoFrameCallback !== "function") return;
    let id = 0;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      frameTimes.current.push(meta.mediaTime);
      const found = measuredFps(frameTimes.current.slice(-40));
      if (found !== null && frameTimes.current.length >= 20) {
        setMeasured(found);
        return;
      }
      id = v.requestVideoFrameCallback!(onFrame);
    };
    id = v.requestVideoFrameCallback(onFrame);
    return () => v.cancelVideoFrameCallback?.(id);
  }, [measured, playing, reportedFps]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    if (video.current) video.current.muted = muted;
  }, [muted]);
  useEffect(() => onPlayingChange?.(playing), [onPlayingChange, playing]);

  const seek = useCallback(
    (seconds: number, fromUser = false) => {
      const v = video.current;
      if (!v) return;
      const to = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : seconds, seconds));
      v.currentTime = to;
      setTime(to);
      if (fromUser) onUserSeek?.(to);
    },
    [onUserSeek]
  );

  const play = useCallback(() => {
    const v = video.current;
    if (!v) return;
    onPlayStart?.();
    void v.play().catch(() => undefined);
  }, [onPlayStart]);

  useImperativeHandle(ref, () => ({
    togglePlay() {
      const v = video.current;
      if (!v) return;
      if (v.paused) play();
      else v.pause();
    },
    seekBy(seconds) {
      seek((video.current?.currentTime ?? 0) + seconds, true);
    },
    currentTime: () => video.current?.currentTime ?? 0,
    pause() {
      video.current?.pause();
    },
    playFrom(seconds) {
      seek(seconds);
      play();
    },
    stepFrame(direction) {
      const v = video.current;
      if (!v) return;
      v.pause();
      seek(stepFrame(v.currentTime, fps ?? FALLBACK_FPS, direction, v.duration), true);
    },
  }));

  const timeAt = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };
  const onTimelineDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    selecting.current = { start: timeAt(event.clientX), moved: false };
  };
  const onTimelineMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = timeAt(event.clientX);
    setHover(at);
    const s = selecting.current;
    if (s) {
      if (Math.abs(at - s.start) > Math.max(0.05, duration / 200)) {
        s.moved = true;
        setRange({ start: Math.min(s.start, at), end: Math.max(s.start, at) });
      }
      return;
    }
    // Hover-scrub (§A): while paused, the frame follows the mouse.
    if (!playing) seek(at);
  };
  const onTimelineUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = selecting.current;
    selecting.current = null;
    if (!s) return;
    if (!s.moved) {
      setRange(null);
      seek(timeAt(event.clientX), true);
    } else if (range) {
      seek(range.start, true);
    }
  };

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = frameBox.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  const view = box ? fitView(box, frame, true) : null;
  const onFrameDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onAddPin || !event.shiftKey || !view || playing || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = local(event);
    pinDrag.current = p;
    setPinDraft({ start: p, end: p });
  };
  const onFrameMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinDrag.current) setPinDraft({ start: pinDrag.current, end: local(event) });
  };
  const onFrameUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pinDrag.current;
    pinDrag.current = null;
    setPinDraft(null);
    if (start && box && view && onAddPin) onAddPin(regionFromDrag(start, local(event), box, view), video.current?.currentTime ?? 0);
  };

  // The pins of the markers that cover this moment (a point marker: half a second), and the one being drawn.
  const shownPins = markers.filter((m) => m.region && time >= m.start - 0.02 && time <= (m.end ?? m.start + POINT_PIN_SECONDS));
  const draft = pinDraft && box && view ? regionFromDrag(pinDraft.start, pinDraft.end, box, view) : null;
  const pct = (seconds: number) => (duration > 0 ? `${(seconds / duration) * 100}%` : "0%");

  return (
    <div className="space-y-2">
      <div
        ref={frameBox}
        className={`relative touch-none select-none overflow-hidden rounded-lg bg-black ${className}`}
        onPointerDown={onFrameDown}
        onPointerMove={onFrameMove}
        onPointerUp={onFrameUp}
        onClick={(event) => {
          if (!event.shiftKey) {
            const v = video.current;
            if (v?.paused) play();
            else v?.pause();
          }
        }}
      >
        {failed ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-sm text-red-300">{t("review.visual.loadFailed")}</p>
        ) : (
          <video
            key={src}
            ref={video}
            src={src}
            loop
            muted={muted}
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            onLoadedMetadata={(event) => {
              setFailed(false);
              setDuration(event.currentTarget.duration);
              setBox({ naturalWidth: event.currentTarget.videoWidth, naturalHeight: event.currentTarget.videoHeight });
              event.currentTarget.playbackRate = rate;
              // §A: plays looped and muted by default.
              void event.currentTarget.play().catch(() => undefined);
            }}
            onPlay={() => setPlaying(true)}
            onPause={(event) => {
              setPlaying(false);
              setTime(event.currentTarget.currentTime);
            }}
            onSeeked={(event) => setTime(event.currentTarget.currentTime)}
            onError={() => setFailed(true)}
          />
        )}
        {box &&
          view &&
          [...shownPins.map((m, i) => ({ region: m.region as PlanMarkerRegion, label: m.label ?? String(i + 1), tone: m.tone })), ...(draft ? [{ region: draft, label: "", tone: "mark" as const }] : [])].map((pin, i) => {
            const c = regionToScreen(pin.region, box, view);
            return (
              <span
                key={i}
                className={`pointer-events-none absolute rounded-full border-2 ${pin.tone === "question" ? "border-sky-400" : pin.tone === "finding" ? "border-red-400" : "border-amber-400"} ${draft && i === shownPins.length ? "border-dashed" : ""}`}
                style={{ left: c.cx - c.radius, top: c.cy - c.radius, width: c.radius * 2, height: c.radius * 2 }}
                title={pin.label}
              />
            );
          })}
      </div>
      {/* The timeline: markers, the loop range, the playhead; hover shows the time (and scrubs while paused). */}
      <div
        ref={timeline}
        role="slider"
        aria-label={t("review.visual.timeline")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 10) / 10}
        aria-valuenow={Math.round(time * 10) / 10}
        tabIndex={-1}
        className="relative h-8 cursor-pointer touch-none rounded-md bg-zinc-800"
        onPointerDown={onTimelineDown}
        onPointerMove={onTimelineMove}
        onPointerUp={onTimelineUp}
        onPointerLeave={() => setHover(null)}
      >
        {markers.map((m, i) => (
          // ui-text-ignore: a CSS length, not text
          <span key={i} title={m.label ?? undefined} className={`absolute top-1 bottom-1 rounded-sm ${TONE_COLORS[m.tone]}`} style={{ left: pct(m.start), width: m.end !== null && m.end > m.start ? `calc(${pct(m.end - m.start)} + 2px)` : "3px" }} />
        ))}
        {range && <span className="absolute inset-y-0 rounded-sm border border-indigo-300/70 bg-indigo-400/20" style={{ left: pct(range.start), width: pct(range.end - range.start) }} />}
        <span className="absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(time) }} />
        {hover !== null && (
          <>
            <span className="absolute inset-y-0 w-px bg-zinc-400/70" style={{ left: pct(hover) }} />
            <span className="absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 text-[11px] text-zinc-100" style={{ left: pct(hover) }}>
              {formatPlayerTime(hover)}
            </span>
          </>
        )}
      </div>
      <div className={`flex flex-wrap items-center gap-2 text-xs text-zinc-300 ${compact ? "" : "pt-0.5"}`}>
        <button type="button" onClick={() => (playing ? video.current?.pause() : play())} className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-white hover:bg-zinc-600" aria-label={playing ? t("review.visual.pause") : t("review.visual.play")} title={playing ? t("review.visual.pause") : t("review.visual.play")}>
          {/* ui-text-ignore: play / pause symbols */}
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" onClick={() => video.current && (video.current.pause(), seek(stepFrame(video.current.currentTime, fps ?? FALLBACK_FPS, -1, video.current.duration), true))} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800" title={t("review.visual.frameBack")} aria-label={t("review.visual.frameBack")}>
          {/* ui-text-ignore: a keyboard key */}‹ ,
        </button>
        <button type="button" onClick={() => video.current && (video.current.pause(), seek(stepFrame(video.current.currentTime, fps ?? FALLBACK_FPS, 1, video.current.duration), true))} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800" title={t("review.visual.frameForward")} aria-label={t("review.visual.frameForward")}>
          {/* ui-text-ignore: a keyboard key */}. ›
        </button>
        <span className="font-mono">
          {formatPlayerTime(time)} / {formatPlayerTime(duration)}
        </span>
        <span className="text-zinc-500">{fps !== null ? t("review.visual.frame", { frame: frameAt(time, fps), fps: Math.round(fps * 100) / 100 }) : t("review.visual.frameUnknown")}</span>
        <span className="inline-flex gap-0.5 rounded-md bg-zinc-950 p-0.5" role="group" aria-label={t("review.visual.speed")}>
          {RATES.map((r) => (
            <button key={r} type="button" onClick={() => setRate(r)} aria-pressed={rate === r} className={`rounded px-1.5 py-0.5 ${rate === r ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
              {/* ui-text-ignore: a playback speed */}
              {`${r}×`}
            </button>
          ))}
        </span>
        <button type="button" onClick={() => setMuted((m) => !m)} aria-pressed={!muted} className={`rounded border px-2 py-0.5 ${muted ? "border-zinc-700 text-zinc-400" : "border-emerald-600 text-emerald-200"}`}>
          {muted ? t("review.visual.soundOff") : t("review.visual.soundOn")}
        </button>
        {range ? (
          <button type="button" onClick={() => setRange(null)} className="rounded border border-indigo-500/60 px-2 py-0.5 text-indigo-200 hover:bg-indigo-500/10">
            {t("review.visual.loopRange", { start: formatPlayerTime(range.start), end: formatPlayerTime(range.end) })} ×
          </button>
        ) : (
          !compact && <span className="text-zinc-600">{t("review.visual.rangeHint")}</span>
        )}
      </div>
    </div>
  );
});
