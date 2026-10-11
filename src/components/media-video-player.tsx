"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PlanMarkerRegion } from "@/lib/generation-plans/contracts";
import { formatPlayerTime } from "./media-review-player";
import { useUiText } from "./ui-text-provider";
import { fitView, frameAt, isWrap, lastFrameTime, measuredFps, regionFromDrag, regionToScreen, sameProportions, seamJump, seamWindowOf, splitAt, stepFrame, wipeClip, type ImageBox } from "./visual-review-model";

/**
 * BL-175 phase 2 (review): where the second clip of a wipe / difference stands for the first one's `time` -- the same moment, or,
 * past its own end (a shorter clip), its last frame (held, so it never wraps and gets sent back on every frame).
 */
function followerTime(time: number, followerDuration: number, fps: number | null): { at: number; hold: boolean } {
  if (!(followerDuration > 0)) return { at: time, hold: false };
  const last = lastFrameTime(followerDuration, fps);
  return time >= last ? { at: last, hold: true } : { at: time, hold: false };
}

// BL-175 (FO-REQ-0018 §A/§C, VISUAL_REVIEW_PLAN.md §2.9): one clip of a review -- looped and muted by default, speed 0.25-2, one
// frame back and forward (the row's fps, else measured while it plays, else 1/30 s), a timeline that scrubs under the mouse while
// paused, a dragged range that loops, the markers as ranges on the timeline, and pins on the frame. Shift + drag on the paused
// frame sets a pin. It knows nothing about plans; the screen drives it through the handle like the audio player.


/** Keeps a drag going outside the frame; a pointer the browser no longer tracks cannot be captured (harmless). */
function capture(event: { currentTarget: Element; pointerId: number }) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // The drag still works inside the frame.
  }
}

export type VideoMarker = { start: number; end: number | null; label: string | null; tone: "finding" | "mark" | "question"; region?: PlanMarkerRegion };

export type VideoPlayerHandle = {
  togglePlay(): void;
  seekBy(seconds: number): void;
  currentTime(): number;
  pause(): void;
  playFrom(seconds: number): void;
  /** One frame back (-1) or forward (+1); pauses. */
  stepFrame(direction: 1 | -1): void;
  /** A linked player follows: moves to `seconds` without telling anyone, then plays or pauses as asked (or keeps its state). */
  seekTo(seconds: number, mode?: "keep" | "play" | "pause"): void;
  isPlaying(): boolean;
  /** Phase 2 (§F): the whole clip `times` times without a gap from the start, then it stops. */
  playTimes(times: number): void;
};

/** BL-175 phase 2 (§E): a second clip drawn in this player's frame, following its moment, play and speed (wipe or difference). */
export type VideoOverlay = { src: string; mode: "wipe" | "difference"; split: number; onSplit: (split: number) => void; labels: { first: string; second: string } };

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
    /** Seeks made here (and whether this clip plays on), so a linked player (compare) can follow. */
    onUserSeek?: (seconds: number, playing: boolean) => void;
    /** Review round 2: play or pause asked for here (the button, a click on the frame), with the moment -- for a linked player. */
    onUserPlay?: (playing: boolean, seconds: number) => void;
    onPlayingChange?: (playing: boolean) => void;
    /** Starts playing once loaded (the default, §A); off when a linked pair starts together (`onReady`). */
    autoPlay?: boolean;
    /** Phase 2 (§E): opens paused at this moment (a question's marker) instead of playing. */
    initialTime?: number | null;
    /** Phase 2 (§F): plays the seam -- the last `seam` seconds straight into the first, on repeat (null = off). */
    seam?: boolean;
    /** Phase 2 (§E): a second clip in the same frame. */
    overlay?: VideoOverlay;
    /** The clip's metadata is loaded (it can be sought and played). */
    onReady?: () => void;
    className?: string;
    /** Starts muted (the default) -- FO-REQ-0018 §A. */
    startMuted?: boolean;
    compact?: boolean;
  }
>(function MediaVideoPlayer({ src, markers, fps: reportedFps, onAddPin, onPlayStart, onUserSeek, onUserPlay, onPlayingChange, autoPlay = true, onReady, initialTime = null, seam = false, overlay, className = "h-[48vh]", startMuted = true, compact = false }, ref) {
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
  // Review round 1: where a hover-scrub started -- the frame comes back when the mouse leaves without a click.
  const scrubFrom = useRef<number | null>(null);
  const pinDrag = useRef<{ x: number; y: number } | null>(null);
  // Phase 2: the second clip (wipe / difference), "×5" (passes left and the last moment seen), the wipe line being dragged.
  const second = useRef<HTMLVideoElement | null>(null);
  const runs = useRef<{ left: number; total: number; last: number } | null>(null);
  const [runShown, setRunShown] = useState<{ pass: number; total: number } | null>(null);
  const [secondBox, setSecondBox] = useState<{ src: string; box: ImageBox } | null>(null);
  // Review: the second clip that could not load -- said, never shown as if it were the first one.
  const [secondFailed, setSecondFailed] = useState<string | null>(null);
  const splitDrag = useRef(false);
  const [pinDraft, setPinDraft] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const fps = reportedFps ?? measured;
  // Review: the seam window and a loop range would fight over the playhead -- while the seam is on, the range rests (it comes
  // back when the seam is turned off).
  const loopRange = seam ? null : range;
  const fpsRef = useRef<number | null>(fps);
  useEffect(() => {
    fpsRef.current = fps;
  }, [fps]);

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
        if (loopRange && (v.currentTime >= loopRange.end || v.currentTime < loopRange.start - 0.05)) v.currentTime = loopRange.start;
        // §F: the seam window -- past the first second, back to a second before the end (the browser's loop makes the join).
        const window = seam && !runs.current ? seamWindowOf(v.duration) : null;
        const jump = window !== null ? seamJump(v.currentTime, v.duration, window) : null;
        if (jump !== null) v.currentTime = jump;
        // §F: "×5" -- count the wraps; the last one stops the clip at its start.
        const r = runs.current;
        if (r) {
          if (isWrap(r.last, v.currentTime, v.duration)) {
            r.left -= 1;
            if (r.left <= 0) {
              runs.current = null;
              setRunShown(null);
              v.pause();
              v.currentTime = 0;
            } else setRunShown({ pass: r.total - r.left + 1, total: r.total });
          }
          if (runs.current) runs.current.last = v.currentTime;
        }
        // §E: the second clip follows -- corrected when it drifts by more than half a frame.
        const o = second.current;
        if (o && !o.seeking) {
          const follow = followerTime(v.currentTime, o.duration, fpsRef.current);
          if (Math.abs(o.currentTime - follow.at) > 0.5 / (fpsRef.current ?? 30)) o.currentTime = follow.at;
          if (follow.hold) {
            if (!o.paused) o.pause();
          } else if (o.paused) void o.play().catch(() => undefined);
        }
        setTime(v.currentTime);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, loopRange, seam]);

  // The frame rate when the row gives none: the presented frames' media times while it plays.
  useEffect(() => {
    const v = video.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (id: number) => void }) | null;
    // Only at 1×: at 2× frames above the display rate are dropped and the median gap doubles (review round 1).
    if (!v || reportedFps !== null || measured !== null || !playing || rate !== 1 || typeof v.requestVideoFrameCallback !== "function") return;
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
  }, [measured, playing, rate, reportedFps]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
    if (second.current) second.current.playbackRate = rate;
  }, [rate]);
  // §E: paused, the second clip shows the same frame (a step, a seek); playing, the tick keeps it there.
  useEffect(() => {
    const o = second.current;
    if (!o || playing) return;
    o.pause();
    o.currentTime = followerTime(time, o.duration, fpsRef.current).at;
  }, [playing, time, overlay?.src]);
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
      if (fromUser) {
        // A step, a seek or a click commits the moment: a hover-scrub no longer gives its frame back (review round 2).
        scrubFrom.current = null;
        onUserSeek?.(to, !v.paused);
      }
    },
    [onUserSeek]
  );

  const play = useCallback(() => {
    const v = video.current;
    if (!v) return;
    scrubFrom.current = null;
    onPlayStart?.();
    void v.play().catch(() => undefined);
  }, [onPlayStart]);
  /** Play or pause asked for in this player itself (the button, a click on the frame): a linked player follows. */
  const toggleHere = () => {
    const v = video.current;
    if (!v) return;
    const wasPaused = v.paused;
    if (wasPaused) play();
    else v.pause();
    onUserPlay?.(wasPaused, v.currentTime);
  };

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
    seekTo(seconds, mode = "keep") {
      const v = video.current;
      if (!v) return;
      // Led by the other clip: a hover-scrub here no longer gives its frame back (review round 3).
      scrubFrom.current = null;
      seek(seconds);
      if (mode === "pause") v.pause();
      else if (mode === "play" && v.paused) play();
    },
    isPlaying: () => Boolean(video.current && !video.current.paused),
    playTimes(times) {
      const v = video.current;
      if (!v || !(times > 0)) return;
      runs.current = { left: times, total: times, last: 0 };
      setRunShown({ pass: 1, total: times });
      setRange(null);
      seek(0);
      play();
    },
  }));

  const timeAt = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };
  const onTimelineDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    capture(event);
    // A press commits: the scrub's frame is no longer given back.
    scrubFrom.current = null;
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
    // Hover-scrub (§A): while paused, the frame follows the mouse -- and comes back when it leaves without a click.
    if (!playing) {
      if (scrubFrom.current === null) scrubFrom.current = video.current?.currentTime ?? time;
      seek(at);
    }
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
    capture(event);
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
          if (!event.shiftKey) toggleHere();
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
              // Phase 2 (§E): a question about a spot opens paused there, so its pin shows.
              if (initialTime !== null) {
                event.currentTarget.currentTime = Math.min(initialTime, event.currentTarget.duration || initialTime);
                setTime(event.currentTarget.currentTime);
              } else if (autoPlay) void event.currentTarget.play().catch(() => undefined);
              // §A: plays looped and muted by default.
              onReady?.();
            }}
            onPlay={() => setPlaying(true)}
            onPause={(event) => {
              setPlaying(false);
              setTime(event.currentTarget.currentTime);
              // A pause by the owner ends "×5" (its own last stop has ended it already).
              if (runs.current) {
                runs.current = null;
                setRunShown(null);
              }
            }}
            onSeeked={(event) => {
              setTime(event.currentTarget.currentTime);
              if (second.current) second.current.currentTime = followerTime(event.currentTarget.currentTime, second.current.duration, fpsRef.current).at;
            }}
            onError={() => {
              setFailed(true);
              // A clip that cannot load never holds a linked one back (review round 3).
              onReady?.();
            }}
          />
        )}
        {overlay && !failed && secondFailed === overlay.src ? (
          <span className="pointer-events-none absolute right-2 top-2 z-10 rounded bg-red-950/90 px-1.5 py-0.5 text-[11px] text-red-200">{t("review.compare.secondFailed", { name: overlay.labels.second })}</span>
        ) : null}
        {overlay && !failed && secondFailed !== overlay.src ? (
          <div className="pointer-events-none absolute inset-0" style={overlay.mode === "wipe" ? { clipPath: wipeClip(overlay.split) } : { mixBlendMode: "difference" }}>
            <video
              key={overlay.src}
              ref={second}
              src={overlay.src}
              loop
              muted
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(event) => {
                setSecondBox({ src: overlay.src, box: { naturalWidth: event.currentTarget.videoWidth, naturalHeight: event.currentTarget.videoHeight } });
                event.currentTarget.playbackRate = rate;
                event.currentTarget.currentTime = video.current?.currentTime ?? 0;
                if (video.current && !video.current.paused) void event.currentTarget.play().catch(() => undefined);
              }}
              onError={() => setSecondFailed(overlay.src)}
            />
          </div>
        ) : null}
        {overlay?.mode === "wipe" && !failed && secondFailed !== overlay.src ? (
          <>
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-zinc-100">{overlay.labels.first}</span>
            <span className="pointer-events-none absolute right-2 top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-zinc-100">{overlay.labels.second}</span>
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={t("review.compare.wipeLine")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(overlay.split * 100)}
              className="absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize touch-none"
              // ui-text-ignore: a CSS length, not text
              style={{ left: `${overlay.split * 100}%` }}
              onPointerDown={(event) => {
                event.stopPropagation();
                capture(event);
                splitDrag.current = true;
              }}
              onPointerMove={(event) => {
                if (!splitDrag.current) return;
                event.stopPropagation();
                const rect = frameBox.current?.getBoundingClientRect();
                if (rect) overlay.onSplit(splitAt(event.clientX - rect.left, rect.width));
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                splitDrag.current = false;
              }}
              onPointerCancel={() => {
                splitDrag.current = false;
              }}
              onLostPointerCapture={() => {
                splitDrag.current = false;
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
              <span className="absolute left-1/2 top-1/2 h-8 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/60 bg-white" />
            </span>
          </>
        ) : null}
        {box &&
          view &&
          [...shownPins.map((m, i) => ({ region: m.region as PlanMarkerRegion, label: m.label ?? String(i + 1), tone: m.tone })), ...(draft ? [{ region: draft, label: "", tone: "mark" as const }] : [])].map((pin, i) => {
            const c = regionToScreen(pin.region, box, view);
            return (
              <span
                key={i}
                className={`pointer-events-none absolute flex items-start justify-end rounded-full border-2 ${pin.tone === "question" ? "border-sky-400 text-sky-200" : pin.tone === "finding" ? "border-red-400 text-red-200" : "border-amber-400 text-amber-200"} ${draft && i === shownPins.length ? "border-dashed" : ""}`}
                style={{ left: c.cx - c.radius, top: c.cy - c.radius, width: c.radius * 2, height: c.radius * 2 }}
                title={pin.label}
              >
                {/* The marker's number, as on a picture (its label starts with it). */}
                {pin.label ? <span className="-mr-2 -mt-2 rounded-full bg-black/80 px-1.5 text-[11px] font-semibold">{/^\d+/.exec(pin.label)?.[0] ?? pin.label.slice(0, 1)}</span> : null}
              </span>
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
        onPointerLeave={() => {
          setHover(null);
          if (scrubFrom.current !== null && !selecting.current) seek(scrubFrom.current);
          scrubFrom.current = null;
        }}
      >
        {markers.map((m, i) => (
          // ui-text-ignore: a CSS length, not text
          <span key={i} title={m.label ?? undefined} className={`absolute top-1 bottom-1 rounded-sm ${TONE_COLORS[m.tone]}`} style={{ left: pct(m.start), width: m.end !== null && m.end > m.start ? `calc(${pct(m.end - m.start)} + 2px)` : "3px" }} />
        ))}
        {loopRange && <span className="absolute inset-y-0 rounded-sm border border-indigo-300/70 bg-indigo-400/20" style={{ left: pct(loopRange.start), width: pct(loopRange.end - loopRange.start) }} />}
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
        <button type="button" onClick={toggleHere} className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-white hover:bg-zinc-600" aria-label={playing ? t("review.visual.pause") : t("review.visual.play")} title={playing ? t("review.visual.pause") : t("review.visual.play")}>
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
        {runShown ? <span className="rounded bg-violet-500/20 px-2 py-0.5 text-violet-200">{t("review.loop.pass", { pass: runShown.pass, total: runShown.total })}</span> : null}
        {overlay && box && secondBox && secondBox.src === overlay.src && !sameProportions({ width: box.naturalWidth, height: box.naturalHeight }, { width: secondBox.box.naturalWidth, height: secondBox.box.naturalHeight }) ? (
          <span className="text-amber-300">{t("review.compare.proportionsDiffer", { first: `${box.naturalWidth}×${box.naturalHeight}`, second: `${secondBox.box.naturalWidth}×${secondBox.box.naturalHeight}` })}</span>
        ) : null}
        {loopRange ? (
          <button type="button" onClick={() => setRange(null)} className="rounded border border-indigo-500/60 px-2 py-0.5 text-indigo-200 hover:bg-indigo-500/10">
            {t("review.visual.loopRange", { start: formatPlayerTime(loopRange.start), end: formatPlayerTime(loopRange.end) })} ×
          </button>
        ) : (
          !compact && <span className="text-zinc-600">{t("review.visual.rangeHint")}</span>
        )}
      </div>
    </div>
  );
});
