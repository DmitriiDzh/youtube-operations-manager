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
  /** For A/B: stop here, and resume from a given second. */
  pause(): void;
  playFrom(seconds: number): void;
};

/** BL-143 phase 3 (FO-MSG-0009 §4): a frequency the validator flagged (a ringing tone, a held note), drawn on the spectrogram. */
export type FrequencyMark = { hz: number; label: string };
export const SPECTROGRAM_MAX_HZ = 16_000;
/** The decoding rate: the full audible band (the default 8 kHz would cut everything above 4 kHz). */
export const DECODE_SAMPLE_RATE = 44_100;
const SPECTROGRAM_HEIGHT = 128;

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
  setVolume(volume: number): void;
  getDecodedData(): { numberOfChannels: number; sampleRate: number; getChannelData(i: number): Float32Array } | null;
  on(event: string, callback: (...args: unknown[]) => void): () => void;
  destroy(): void;
};
type RegionLike = { id: string; start: number; end: number; play(): void; remove(): void };
type RegionsLike = {
  clearRegions(): void;
  getRegions(): RegionLike[];
  addRegion(options: { id?: string; start: number; end?: number; color?: string; drag?: boolean; resize?: boolean; content?: string }): RegionLike;
  enableDragSelection(options: { color?: string; id?: string }): () => void;
  on(event: string, callback: (...args: unknown[]) => void): () => void;
};

/** BL-143 phase 3 (AC-GP3-06): the selection the owner drags to loop -- one at a time, never a verdict marker. */
const SELECTION_ID = "ytm-selection";
const SELECTION_COLOR = "rgba(129, 140, 248, 0.22)";

const MARKER_COLORS = { finding: "rgba(239, 68, 68, 0.28)", mark: "rgba(245, 158, 11, 0.35)" } as const;

export type MediaReviewPlayerProps = {
  src: string;
  markers: ReviewMarker[];
  /** 0..1, applied to playback only (AC-GP3-04 loudness match). */
  volume?: number;
  /** AC-GP3-05: draw the spectrogram under the waveform (from the same decoded audio). */
  spectrogram?: boolean;
  /** Called once the audio is decoded, with its channels (for measuring loudness in the browser). */
  onDecoded?: (audio: { channels: Float32Array[]; sampleRate: number }) => void;
  /** Frequencies to mark on the spectrogram (only drawn while it is shown). */
  frequencyMarks?: FrequencyMark[];
  /** Called when this track starts playing (A/B: the reference must stop then). */
  onPlayStart?: () => void;
};

export const MediaReviewPlayer = forwardRef<ReviewPlayerHandle, MediaReviewPlayerProps>(function MediaReviewPlayer({ src, markers, volume = 1, spectrogram = false, onDecoded, frequencyMarks = [], onPlayStart }, ref) {
  const container = useRef<HTMLDivElement | null>(null);
  const spectrogramContainer = useRef<HTMLDivElement | null>(null);
  const wave = useRef<WaveSurferLike | null>(null);
  const regions = useRef<RegionsLike | null>(null);
  const [state, setState] = useState<{ time: number; duration: number; playing: boolean; error: string | null; ready: boolean }>({ time: 0, duration: 0, playing: false, error: null, ready: false });
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(false);
  const onDecodedRef = useRef(onDecoded);
  const onPlayStartRef = useRef(onPlayStart);
  useEffect(() => {
    loopRef.current = loop;
    onDecodedRef.current = onDecoded;
    onPlayStartRef.current = onPlayStart;
  });

  useImperativeHandle(ref, () => ({
    togglePlay: () => void wave.current?.playPause(),
    seekBy: (seconds) => {
      const w = wave.current;
      if (!w) return;
      w.setTime(Math.max(0, Math.min(w.getDuration(), w.getCurrentTime() + seconds)));
    },
    currentTime: () => wave.current?.getCurrentTime() ?? 0,
    pause: () => {
      const w = wave.current as (WaveSurferLike & { pause?: () => void }) | null;
      w?.pause?.();
    },
    playFrom: (seconds) => {
      const w = wave.current as (WaveSurferLike & { play?: () => Promise<void> }) | null;
      if (!w) return;
      w.setTime(Math.max(0, Math.min(w.getDuration(), seconds)));
      void w.play?.();
    },
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
        // Independent review: wavesurfer decodes at 8 kHz by default -- the spectrogram and the loudness measurement need
        // the full band (content up to 22 kHz).
        sampleRate: DECODE_SAMPLE_RATE,
        plugins: [plugin],
      }) as unknown as WaveSurferLike;
      wave.current = instance;
      regions.current = plugin as unknown as RegionsLike;
      // A new file starts with no selection and not ready.
      setSelection(null);
      setLoop(false);
      setState({ time: 0, duration: 0, playing: false, error: null, ready: false });
      instance.on("ready", () => {
        setState((s) => ({ ...s, ready: true, duration: instance?.getDuration() ?? 0 }));
        const audio = instance?.getDecodedData();
        if (audio && onDecodedRef.current) {
          onDecodedRef.current({ channels: Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i)), sampleRate: audio.sampleRate });
        }
      });
      // AC-GP3-06: dragging on the waveform selects ONE range (a new drag replaces it); "Loop" replays it.
      const regionsPlugin = plugin as unknown as RegionsLike;
      regionsPlugin.enableDragSelection({ color: SELECTION_COLOR, id: SELECTION_ID });
      regionsPlugin.on("region-created", (created) => {
        const region = created as RegionLike;
        if (!region.id.startsWith(SELECTION_ID) && region.id !== SELECTION_ID) return;
        for (const other of regionsPlugin.getRegions()) if (other !== region && (other.id === SELECTION_ID || other.id.startsWith(SELECTION_ID))) other.remove();
        setSelection({ start: region.start, end: region.end });
      });
      regionsPlugin.on("region-updated", (updated) => {
        const region = updated as RegionLike;
        if (region.id === SELECTION_ID || region.id.startsWith(SELECTION_ID)) setSelection({ start: region.start, end: region.end });
      });
      regionsPlugin.on("region-out", (left) => {
        const region = left as RegionLike;
        if (loopRef.current && (region.id === SELECTION_ID || region.id.startsWith(SELECTION_ID))) region.play();
      });
      instance.on("timeupdate", () => setState((s) => ({ ...s, time: instance?.getCurrentTime() ?? 0 })));
      instance.on("play", () => {
        setState((s) => ({ ...s, playing: true }));
        onPlayStartRef.current?.();
      });
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

  // AC-GP3-05: the spectrogram is a plugin registered on the SAME player while shown (toggling never rebuilds the player, so
  // volume, markers and the selection stay). Linear scale, so the frequency marks below line up.
  useEffect(() => {
    if (!spectrogram || !state.ready || !wave.current || !spectrogramContainer.current) return;
    let cancelled = false;
    let registered: { destroy(): void } | null = null;
    const instance = wave.current as unknown as { registerPlugin<T>(plugin: T): T; unregisterPlugin(plugin: unknown): void };
    void import("wavesurfer.js/plugins/spectrogram").then(({ default: SpectrogramPlugin }) => {
      if (cancelled || !spectrogramContainer.current) return;
      registered = instance.registerPlugin(
        SpectrogramPlugin.create({ container: spectrogramContainer.current, height: SPECTROGRAM_HEIGHT, labels: true, frequencyMax: SPECTROGRAM_MAX_HZ, scale: "linear" })
      ) as unknown as { destroy(): void };
    });
    return () => {
      cancelled = true;
      // unregisterPlugin removes it from the player's list too (destroy alone would leave it there).
      if (registered) instance.unregisterPlugin(registered);
    };
  }, [spectrogram, state.ready]);

  useEffect(() => {
    wave.current?.setVolume(Math.max(0, Math.min(1, volume)));
  }, [volume, state.ready]);

  // The ranges are redrawn whenever they (or readiness) change.
  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !state.ready) return;
    // Markers are redrawn; the owner's loop selection is kept.
    for (const r of plugin.getRegions()) if (r.id !== SELECTION_ID && !r.id.startsWith(SELECTION_ID)) r.remove();
    for (const m of markers) {
      plugin.addRegion({ start: m.start, ...(m.end !== null && m.end > m.start ? { end: m.end } : {}), color: MARKER_COLORS[m.tone], drag: false, resize: false, ...(m.label ? { content: m.label } : {}) });
    }
  }, [markers, state.ready]);

  return (
    <div className="space-y-2">
      <div ref={container} className="min-h-24 w-full rounded-md bg-zinc-950" />
      <div className={spectrogram ? "relative w-full" : "hidden"} style={{ height: SPECTROGRAM_HEIGHT }}>
        <div ref={spectrogramContainer} className="absolute inset-0" />
        {spectrogram &&
          frequencyMarks
            .filter((m) => m.hz > 0 && m.hz < SPECTROGRAM_MAX_HZ)
            .map((m, i) => (
              <div key={i} className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-red-400/80" style={{ top: `${(1 - m.hz / SPECTROGRAM_MAX_HZ) * 100}%` }}>
                <span className="absolute right-1 -top-4 rounded bg-zinc-950/80 px-1 text-[10px] text-red-300">
                  {m.label} {Math.round(m.hz)} Hz
                </span>
              </div>
            ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <button type="button" onClick={() => void wave.current?.playPause()} disabled={!state.ready} className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {state.playing ? "Pause" : "Play"}
        </button>
        <span className="font-mono">
          {formatPlayerTime(state.time)} / {formatPlayerTime(state.duration)}
        </span>
        {selection && (
          <>
            <span>
              selection {formatPlayerTime(selection.start)}–{formatPlayerTime(selection.end)}
            </span>
            <button type="button" onClick={() => setLoop((v) => !v)} className={`rounded-md border px-2 py-0.5 ${loop ? "border-indigo-400 bg-indigo-500/20 text-indigo-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
              {loop ? "Looping" : "Loop"}
            </button>
            <button
              type="button"
              onClick={() => {
                for (const r of regions.current?.getRegions() ?? []) if (r.id === SELECTION_ID || r.id.startsWith(SELECTION_ID)) r.remove();
                setSelection(null);
                setLoop(false);
              }}
              className="text-zinc-400 hover:text-zinc-100"
            >
              Clear
            </button>
          </>
        )}
        {!selection && state.ready && <span className="text-zinc-500">drag on the waveform to select a range to loop</span>}
        {!state.ready && !state.error && <span>Loading the waveform…</span>}
        {state.error && <span className="text-red-400">{state.error}</span>}
      </div>
    </div>
  );
});
