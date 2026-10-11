"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PlanMarkerRegion } from "@/lib/generation-plans/contracts";
import { useUiText } from "./ui-text-provider";
import { FIT, regionFromDrag, regionToScreen, stateOf, toggleActual, viewOf, zoomAround, type ImageBox, type ViewState } from "./visual-review-model";

// BL-175 (FO-REQ-0018 §A/§C, VISUAL_REVIEW_PLAN.md §2.9): one image of a review -- fit to the frame, 100 % on Z or a double click,
// drag to pan, the wheel to zoom around the cursor, and the owner's pins as numbered circles; Shift + drag sets a new pin (the
// drag's length is its radius). It knows nothing about plans: the screen gives it a URL, the pins and what to do with a new one.
// `view` / `onViewChange` let two viewers share one view (compare: linked zoom and pan).


/** Keeps a drag going outside the frame; a pointer the browser no longer tracks cannot be captured (harmless). */
function capture(event: { currentTarget: Element; pointerId: number }) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // The drag still works inside the frame.
  }
}

export type ViewerPin = { region: PlanMarkerRegion; label: string; tone: "mark" | "draft" | "question" | "previous"; title?: string | null };

export type ImageViewerHandle = { toggleActual(): void };

const PIN_COLORS: Record<ViewerPin["tone"], string> = {
  mark: "border-amber-400 text-amber-200",
  draft: "border-amber-300 border-dashed text-amber-100",
  question: "border-sky-400 text-sky-200",
  previous: "border-zinc-400 text-zinc-200",
};

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

export const MediaImageViewer = forwardRef<
  ImageViewerHandle,
  {
    src: string;
    pins: ViewerPin[];
    /** Shift + drag on the image: the pin's region (absent = no new pins here). */
    onAddPin?: (region: PlanMarkerRegion) => void;
    /** A shared view (compare); absent = the viewer keeps its own. */
    view?: ViewState;
    onViewChange?: (view: ViewState) => void;
    /** The file's size in bytes, when known (the readout). */
    bytes?: number | null;
    className?: string;
    /** The readout line under the image (zoom, pixels, bytes). */
    readout?: boolean;
    /**
     * The wheel zooms always (the whole-window layer), or only with Ctrl / ⌘ -- a trackpad pinch -- so that on the screen itself
     * the wheel keeps scrolling the column (the default).
     */
    wheelZoom?: "always" | "modifier";
  }
>(function MediaImageViewer({ src, pins, onAddPin, view: shared, onViewChange, bytes = null, className = "h-[52vh]", readout = true, wheelZoom = "modifier" }, ref) {
  const { t, formatNumber } = useUiText();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState<ImageBox | null>(null);
  const [own, setOwn] = useState<ViewState>(FIT);
  const [failed, setFailed] = useState(false);
  const state = shared ?? own;
  const setState = useCallback(
    (next: ViewState) => {
      if (onViewChange) onViewChange(next);
      if (!shared) setOwn(next);
    },
    [onViewChange, shared]
  );
  // A drag in progress: panning, or a pin being drawn (Shift).
  const drag = useRef<{ kind: "pan" | "pin"; startX: number; startY: number; lastX: number; lastY: number } | null>(null);
  const [pinDraft, setPinDraft] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const view = box ? viewOf(state, box, frame) : null;

  useImperativeHandle(ref, () => ({
    toggleActual() {
      if (box) setState(toggleActual(state, box, frame));
    },
  }));

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = frameRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!box || !view || event.button !== 0) return;
    const p = local(event);
    const kind = event.shiftKey && onAddPin ? "pin" : "pan";
    if (kind === "pan" && state.fit) return;
    capture(event);
    drag.current = { kind, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y };
    if (kind === "pin") setPinDraft({ start: p, end: p });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !box || !view) return;
    const p = local(event);
    if (d.kind === "pin") setPinDraft({ start: { x: d.startX, y: d.startY }, end: p });
    else {
      setState(stateOf({ scale: view.scale, offsetX: view.offsetX + (p.x - d.lastX), offsetY: view.offsetY + (p.y - d.lastY) }, box, frame));
      d.lastX = p.x;
      d.lastY = p.y;
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !box || !view) return;
    if (d.kind === "pin") {
      setPinDraft(null);
      onAddPin?.(regionFromDrag({ x: d.startX, y: d.startY }, local(event), box, view));
    }
  };
  // The wheel, as a native listener: React's is passive, and a zoom must keep the page from scrolling too.
  const wheel = useRef({ view, box, frame, setState, wheelZoom });
  useEffect(() => {
    wheel.current = { view, box, frame, setState, wheelZoom };
  });
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const w = wheel.current;
      if (!w.box || !w.view) return;
      if (w.wheelZoom === "modifier" && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, w.view.scale * factor));
      w.setState(stateOf(zoomAround(w.view, scale, event.clientX - rect.left, event.clientY - rect.top), w.box, w.frame));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const draftRegion = pinDraft && box && view ? regionFromDrag(pinDraft.start, pinDraft.end, box, view) : null;
  const circles = [...pins, ...(draftRegion ? [{ region: draftRegion, label: "", tone: "draft" as const }] : [])];

  return (
    <div className="space-y-1">
      <div
        ref={frameRef}
        className={`relative touch-none select-none overflow-hidden rounded-lg bg-[repeating-conic-gradient(#27272a_0%_25%,#1f1f23_0%_50%)] bg-[length:16px_16px] ${state.fit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"} ${className}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setPinDraft(null);
        }}
        onDoubleClick={(event) => box && setState(toggleActual(state, box, frame, local(event)))}
      >
        {failed ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-sm text-red-300">{t("review.visual.loadFailed")}</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a local file of this computer, served by the audition route
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            onLoad={(event) => {
              setFailed(false);
              setBox({ naturalWidth: event.currentTarget.naturalWidth, naturalHeight: event.currentTarget.naturalHeight });
            }}
            onError={() => setFailed(true)}
            className="absolute left-0 top-0 max-w-none origin-top-left"
            // ui-text-ignore: CSS values, not text
            style={view && box ? { width: box.naturalWidth * view.scale, height: box.naturalHeight * view.scale, transform: `translate(${view.offsetX}px, ${view.offsetY}px)` } : { opacity: 0 }}
          />
        )}
        {box &&
          view &&
          circles.map((pin, i) => {
            const c = regionToScreen(pin.region, box, view);
            return (
              <span
                key={`${pin.label}-${i}`}
                title={pin.title ?? undefined}
                className={`pointer-events-none absolute flex items-start justify-end rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] ${PIN_COLORS[pin.tone]}`}
                style={{ left: c.cx - c.radius, top: c.cy - c.radius, width: c.radius * 2, height: c.radius * 2 }}
              >
                {pin.label ? <span className="-mr-2 -mt-2 rounded-full bg-black/80 px-1.5 text-[11px] font-semibold">{pin.label}</span> : null}
              </span>
            );
          })}
      </div>
      {readout && (
        <p className="flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
          <span>{state.fit ? t("review.visual.zoomFit", { percent: view ? Math.round(view.scale * 100) : 100 }) : t("review.visual.zoom", { percent: view ? Math.round(view.scale * 100) : 100 })}</span>
          {box ? <span>{t("review.visual.pixels", { width: box.naturalWidth, height: box.naturalHeight })}</span> : null}
          {bytes !== null ? <span>{t("review.visual.megabytes", { size: formatNumber(bytes / 1_048_576, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })}</span> : null}
          {onAddPin ? <span className="text-zinc-600">{t("review.visual.pinHint")}</span> : null}
        </p>
      )}
    </div>
  );
});
