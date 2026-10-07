"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// BL-143 (ADR 0029 decision 5, MEDIA_REVIEW_TOOLS.md §2 group A): a generic player for one audio file -- waveform with a
// playhead (wavesurfer.js, loaded only when this component mounts), click to seek, and time ranges drawn as regions. It knows
// nothing about plans; the review screen gives it a URL and the ranges, and drives it through the handle.

export type ReviewMarker = { start: number; end: number | null; label: string | null; tone: "finding" | "mark" };

export type ReviewPlayerHandle = {
  togglePlay(): void;
  seekBy(seconds: number): void;
  currentTime(): number;
};

/** "1:51.2" -- minutes, seconds and a tenth. Exported for its test. */
export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const tenths = Math.floor(seconds * 10) % 10;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${tenths}`;
}

type WaveSurferLike = {
  playPause(): Promise<void> | void;
  getCurrentTime(): number;
  getDuration(): number;
  setTime(seconds: number): void;
  on(event: string, callback: (...args: unknown[]) => void): () => void;
  destroy(): void;
};
type RegionsLike = { clearRegions(): void; addRegion(options: { start: number; end?: number; color?: string; drag?: boolean; resize?: boolean; content?: string }): unknown };

const MARKER_COLORS = { finding: "rgba(239, 68, 68, 0.28)", mark: "rgba(245, 158, 11, 0.35)" } as const;

export const MediaReviewPlayer = forwardRef<ReviewPlayerHandle, { src: string; markers: ReviewMarker[] }>(function MediaReviewPlayer({ src, markers }, ref) {
  const container = useRef<HTMLDivElement | null>(null);
  const wave = useRef<WaveSurferLike | null>(null);
  const regions = useRef<RegionsLike | null>(null);
  const [state, setState] = useState<{ time: number; duration: number; playing: boolean; error: string | null; ready: boolean }>({ time: 0, duration: 0, playing: false, error: null, ready: false });

  useImperativeHandle(ref, () => ({
    togglePlay: () => void wave.current?.playPause(),
    seekBy: (seconds) => {
      const w = wave.current;
      if (!w) return;
      w.setTime(Math.max(0, Math.min(w.getDuration(), w.getCurrentTime() + seconds)));
    },
    currentTime: () => wave.current?.getCurrentTime() ?? 0,
  }));

  // One wavesurfer per file; the library is imported on demand (it touches `window`, so never during prerendering).
  useEffect(() => {
    let cancelled = false;
    let instance: WaveSurferLike | null = null;
    void (async () => {
      const [{ default: WaveSurfer }, { default: RegionsPlugin }] = await Promise.all([import("wavesurfer.js"), import("wavesurfer.js/plugins/regions")]);
      if (cancelled || !container.current) return;
      const plugin = RegionsPlugin.create();
      instance = WaveSurfer.create({
        container: container.current,
        url: src,
        height: 96,
        waveColor: "#52525b",
        progressColor: "#818cf8",
        cursorColor: "#e4e4e7",
        normalize: true,
        plugins: [plugin],
      }) as unknown as WaveSurferLike;
      wave.current = instance;
      regions.current = plugin as unknown as RegionsLike;
      instance.on("ready", () => setState((s) => ({ ...s, ready: true, duration: instance?.getDuration() ?? 0 })));
      instance.on("timeupdate", () => setState((s) => ({ ...s, time: instance?.getCurrentTime() ?? 0 })));
      instance.on("play", () => setState((s) => ({ ...s, playing: true })));
      instance.on("pause", () => setState((s) => ({ ...s, playing: false })));
      instance.on("finish", () => setState((s) => ({ ...s, playing: false })));
      instance.on("error", (error) => setState((s) => ({ ...s, error: error instanceof Error ? error.message : "The file could not be played" })));
    })().catch((error: unknown) => {
      if (!cancelled) setState((s) => ({ ...s, error: error instanceof Error ? error.message : "The player could not be loaded" }));
    });
    return () => {
      cancelled = true;
      instance?.destroy();
      wave.current = null;
      regions.current = null;
    };
  }, [src]);

  // The ranges are redrawn whenever they (or readiness) change.
  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !state.ready) return;
    plugin.clearRegions();
    for (const m of markers) {
      plugin.addRegion({ start: m.start, ...(m.end !== null && m.end > m.start ? { end: m.end } : {}), color: MARKER_COLORS[m.tone], drag: false, resize: false, ...(m.label ? { content: m.label } : {}) });
    }
  }, [markers, state.ready]);

  return (
    <div className="space-y-2">
      <div ref={container} className="min-h-24 w-full rounded-md bg-zinc-950" />
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <button type="button" onClick={() => void wave.current?.playPause()} disabled={!state.ready} className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {state.playing ? "Pause" : "Play"}
        </button>
        <span className="font-mono">
          {formatPlayerTime(state.time)} / {formatPlayerTime(state.duration)}
        </span>
        {!state.ready && !state.error && <span>Loading the waveform…</span>}
        {state.error && <span className="text-red-400">{state.error}</span>}
      </div>
    </div>
  );
});
