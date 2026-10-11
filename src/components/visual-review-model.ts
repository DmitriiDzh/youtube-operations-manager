import { mediaKindOf, type PlanMarkerRegion, type PlanMediaKind } from "@/lib/generation-plans/contracts";
import type { UiTextKey } from "@/lib/ui-text";

// ---------------------------------------------------------------------------
// BL-175 (FO-REQ-0018 §A-§D, docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §2.9): the pure parts of the review screen for images and
// video -- the pin geometry, the frame arithmetic, the reason chips per media kind, the grid's grouping and the keys that only
// pictures have. No React here, so each rule is tested on its own (plan AC-VR-14).
// ---------------------------------------------------------------------------

/**
 * The default reason chips for images and video (FO-REQ-0018 §D, the owner's own feedback first). These exact English values are
 * what a verdict records (the Factory Operator reads them); the screen shows them in the interface language (VISUAL_REASON_KEYS).
 */
// ui-text-ignore: verdict values sent to the API; shown through VISUAL_REASON_KEYS
export const IMAGE_REASONS = ["extra object", "broken object", "wrong pose", "hands / fingers", "face off-model", "duplicated subject", "wrong style / looks AI", "color / palette", "artifacts / blur", "boring / unreadable in 3 s"] as const;
// ui-text-ignore: verdict values sent to the API; shown through VISUAL_REASON_KEYS
export const VIDEO_REASONS = ["loop seam jump", "color / brightness drift", "double / ghost", "face / clothes melting", "shape morphing", "flicker", "unnatural / jerky motion", "too static / too much motion", "unwanted camera motion", "artifacts / blur"] as const;

export const VISUAL_REASON_KEYS: Record<(typeof IMAGE_REASONS)[number] | (typeof VIDEO_REASONS)[number], UiTextKey> = {
  "extra object": "review.reason.extraObject",
  "broken object": "review.reason.brokenObject",
  "wrong pose": "review.reason.wrongPose",
  "hands / fingers": "review.reason.hands",
  "face off-model": "review.reason.faceOffModel",
  "duplicated subject": "review.reason.duplicated",
  "wrong style / looks AI": "review.reason.wrongStyle",
  "color / palette": "review.reason.palette",
  "artifacts / blur": "review.reason.artifacts",
  "boring / unreadable in 3 s": "review.reason.boring",
  "loop seam jump": "review.reason.seam",
  "color / brightness drift": "review.reason.drift",
  "double / ghost": "review.reason.ghost",
  "face / clothes melting": "review.reason.melting",
  "shape morphing": "review.reason.morphing",
  flicker: "review.reason.flicker",
  "unnatural / jerky motion": "review.reason.jerky",
  "too static / too much motion": "review.reason.motionAmount",
  "unwanted camera motion": "review.reason.cameraMotion",
};

/** The chips one entry offers: the wave's own list, else the plan's, else the defaults of its media kind (audio: the music ten). */
export type ReasonChips = { source: "custom"; values: string[] } | { source: "image" | "video" | "audio"; values: readonly string[] };

export function reasonChipsFor(media: PlanMediaKind | null | undefined, groupId: string | null, lists: { plan: readonly string[] | null; groups: Readonly<Record<string, readonly string[]>> }, musicReasons: readonly string[]): ReasonChips {
  const wave = groupId !== null && Object.hasOwn(lists.groups, groupId) ? lists.groups[groupId] : null;
  if (wave && wave.length > 0) return { source: "custom", values: [...wave] };
  if (lists.plan && lists.plan.length > 0) return { source: "custom", values: [...lists.plan] };
  if (media === "image") return { source: "image", values: IMAGE_REASONS };
  if (media === "video") return { source: "video", values: VIDEO_REASONS };
  return { source: "audio", values: musicReasons };
}

/** Whether an entry is a picture (the screen shows it, never plays it as audio). */
export const isVisual = (media: PlanMediaKind | null | undefined): media is "image" | "video" => media === "image" || media === "video";

/**
 * The media kind of an entry of ANOTHER computer's report (the shared format carries no `media`): its accepted revision's file,
 * else its latest stage's reported file, else its job output -- the same order the owning computer plays them in.
 */
export function sharedEntryMedia(entry: { currentFile?: string | null; stages: ReadonlyArray<{ auditionFile: string | null }>; jobOutput?: string | null }): PlanMediaKind | null {
  const reported = [...entry.stages].reverse().find((s) => s.auditionFile !== null)?.auditionFile ?? null;
  return mediaKindOf(entry.currentFile ?? reported ?? entry.jobOutput ?? null);
}

// -- pins (§2.4): x of the width, y of the height, r of the shorter side, all 0..1 --------------------------------------------

export type ImageBox = { naturalWidth: number; naturalHeight: number };
/** How the image is drawn in its frame: the scale (screen px per image px) and the image's top-left corner on screen. */
export type ImageView = { scale: number; offsetX: number; offsetY: number };

/**
 * The scale that fits the whole picture into the frame. An image is never shown above its own size when it fits (`upscale`
 * false); a video fills its frame like `object-fit: contain` (`upscale` true).
 */
export function fitScale(box: ImageBox, frame: { width: number; height: number }, upscale = false): number {
  if (box.naturalWidth <= 0 || box.naturalHeight <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
  const contain = Math.min(frame.width / box.naturalWidth, frame.height / box.naturalHeight);
  return upscale ? contain : Math.min(1, contain);
}

/** The view that shows the whole picture centred in the frame. */
export function fitView(box: ImageBox, frame: { width: number; height: number }, upscale = false): ImageView {
  const scale = fitScale(box, frame, upscale);
  return { scale, offsetX: (frame.width - box.naturalWidth * scale) / 2, offsetY: (frame.height - box.naturalHeight * scale) / 2 };
}

/**
 * What a viewer shows, independent of its frame and of the image's pixel size -- so two viewers of different images can share
 * it (compare: linked zoom and pan). `fit`, or a scale (screen px per image px) and the image point (0..1) at the frame's centre.
 */
export type ViewState = { fit: true } | { fit: false; scale: number; cx: number; cy: number };

export const FIT: ViewState = { fit: true };

/** The drawing of a view state in one frame. */
export function viewOf(state: ViewState, box: ImageBox, frame: { width: number; height: number }): ImageView {
  if (state.fit) return fitView(box, frame);
  return { scale: state.scale, offsetX: frame.width / 2 - state.cx * box.naturalWidth * state.scale, offsetY: frame.height / 2 - state.cy * box.naturalHeight * state.scale };
}

/** The view state of a drawing (the image point at the frame's centre). */
export function stateOf(view: ImageView, box: ImageBox, frame: { width: number; height: number }): ViewState {
  if (box.naturalWidth <= 0 || box.naturalHeight <= 0) return FIT;
  return { fit: false, scale: view.scale, cx: (frame.width / 2 - view.offsetX) / (box.naturalWidth * view.scale), cy: (frame.height / 2 - view.offsetY) / (box.naturalHeight * view.scale) };
}

/** Z: fit ↔ 100 % (one image pixel per screen pixel), keeping the point under (px, py) -- the frame's centre by default -- in place. */
export function toggleActual(state: ViewState, box: ImageBox, frame: { width: number; height: number }, at?: { x: number; y: number }): ViewState {
  if (!state.fit) return FIT;
  const view = viewOf(state, box, frame);
  const p = at ?? { x: frame.width / 2, y: frame.height / 2 };
  return stateOf(zoomAround(view, 1, p.x, p.y), box, frame);
}

/** The view at `scale` that keeps the image point under (px, py) of the frame where it is (a zoom around the cursor). */
export function zoomAround(view: ImageView, scale: number, px: number, py: number): ImageView {
  const ix = (px - view.offsetX) / view.scale;
  const iy = (py - view.offsetY) / view.scale;
  return { scale, offsetX: px - ix * scale, offsetY: py - iy * scale };
}

/** A region's circle on screen: centre and radius in frame pixels. */
export function regionToScreen(region: PlanMarkerRegion, box: ImageBox, view: ImageView): { cx: number; cy: number; radius: number } {
  return {
    cx: view.offsetX + region.x * box.naturalWidth * view.scale,
    cy: view.offsetY + region.y * box.naturalHeight * view.scale,
    radius: region.r * Math.min(box.naturalWidth, box.naturalHeight) * view.scale,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * The region a Shift-drag gives: centred where the press was, as large as the drag (a click alone gives `minRadius` of the
 * shorter side). Inside the image; rounded to 4 decimals (what is stored and sent).
 */
export function regionFromDrag(start: { x: number; y: number }, end: { x: number; y: number }, box: ImageBox, view: ImageView, minRadius = 0.04): PlanMarkerRegion {
  const ix = (start.x - view.offsetX) / view.scale;
  const iy = (start.y - view.offsetY) / view.scale;
  const shorter = Math.min(box.naturalWidth, box.naturalHeight);
  const dragged = Math.hypot(end.x - start.x, end.y - start.y) / view.scale / shorter;
  return { x: round4(clamp01(ix / box.naturalWidth)), y: round4(clamp01(iy / box.naturalHeight)), r: round4(Math.min(1, Math.max(minRadius, dragged))) };
}

// -- video frames (§2.9) -------------------------------------------------------------------------------------------------

/** The frame rate a row reports (`metrics.fps`, the Operator's own number), or null. */
export function fpsFromMetrics(stages: ReadonlyArray<{ metrics: Record<string, unknown> }>): number | null {
  for (const stage of [...stages].reverse()) {
    const fps = stage.metrics.fps;
    if (typeof fps === "number" && Number.isFinite(fps) && fps >= 1 && fps <= 240) return fps;
  }
  return null;
}

/**
 * The frame rate measured while a clip plays: the median gap between presented frames (`requestVideoFrameCallback`'s media
 * times), from at least 8 gaps; snapped to a common rate within 1 %. Null while there are too few.
 */
export function measuredFps(mediaTimes: readonly number[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < mediaTimes.length; i++) {
    const gap = mediaTimes[i] - mediaTimes[i - 1];
    if (gap > 0.001 && gap < 0.5) gaps.push(gap);
  }
  if (gaps.length < 8) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const fps = 1 / sorted[Math.floor(sorted.length / 2)];
  const common = [8, 12, 15, 16, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const near = common.find((c) => Math.abs(c - fps) / c < 0.01);
  return near ?? Math.round(fps * 100) / 100;
}

/** The frame shown at `seconds` (1-based, as editors count). */
export function frameAt(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-6) + 1;
}

/** One frame back or forward from `seconds` -- to the middle of the neighbouring frame, within the clip. */
export function stepFrame(seconds: number, fps: number, direction: 1 | -1, duration: number): number {
  const frame = Math.floor(seconds * fps + 1e-6) + direction;
  const last = Number.isFinite(duration) && duration > 0 ? Math.max(0, Math.ceil(duration * fps) - 1) : Infinity;
  const clamped = Math.min(last, Math.max(0, frame));
  return (clamped + 0.5) / fps;
}

// -- the grid (§2.9) -----------------------------------------------------------------------------------------------------

/** The entries of the grid's scope grouped by item, in the walk's order (an item's first entry places it). */
export function groupByItem<E extends { itemKey: string }>(entries: readonly E[]): Array<{ itemKey: string; entries: E[] }> {
  const out: Array<{ itemKey: string; entries: E[] }> = [];
  for (const e of entries) {
    const group = out.find((g) => g.itemKey === e.itemKey);
    if (group) group.entries.push(e);
    else out.push({ itemKey: e.itemKey, entries: [e] });
  }
  return out;
}

/** An attempt's short name in a list where its item has several attempts: its seed, else its ref without a `job:` prefix. */
export function attemptLabel(entry: { attemptRef: string; seed: number | null }): string {
  if (entry.seed !== null) return String(entry.seed);
  return entry.attemptRef.startsWith("job:") ? entry.attemptRef.slice(4, 12) : entry.attemptRef;
}

// -- keys only pictures have (the music screen's map is unchanged) -------------------------------------------------------

export type VisualKeyAction = "zoom" | "frameBack" | "frameForward" | "grid" | "loupe" | "compare" | "pick" | "close";

/** Z 100 % / fit, `,` `.` one frame, G grid, Enter loupe, C compare, S pick, Esc close the open layer. */
export function visualKeyAction(key: string): VisualKeyAction | null {
  switch (key) {
    case "z":
    case "Z":
      return "zoom";
    case ",":
      return "frameBack";
    case ".":
      return "frameForward";
    case "g":
    case "G":
      return "grid";
    case "Enter":
      return "loupe";
    case "c":
    case "C":
      return "compare";
    case "s":
    case "S":
      return "pick";
    case "Escape":
      return "close";
    default:
      return null;
  }
}

/** The total size of a file from a `Content-Range: bytes 0-0/12345` answer (the image's bytes, read with a 1-byte request). */
export function totalFromContentRange(header: string | null): number | null {
  const match = header ? /\/(\d+)\s*$/.exec(header) : null;
  return match ? Number(match[1]) : null;
}

// -- BL-175 phase 2 (FO-REQ-0018 §E-§F, VISUAL_REVIEW_PLAN.md §7) ------------------------------------------------------------

/** How compare shows the two sides: side by side, a wipe the owner drags, or the difference blend. */
export type CompareView = "side" | "wipe" | "difference";

/** A wipe's split, 0 (all second side) .. 1 (all first side), from a pointer `x` over a frame `width` px wide. */
export function splitAt(x: number, width: number): number {
  if (!(width > 0)) return 0.5;
  return Math.min(1, Math.max(0, x / width));
}

/** The CSS clip of the second side at a split: it shows right of the line. */
export function wipeClip(split: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, split)) * 10000) / 100;
  // ui-text-ignore: a CSS value, not text
  return `inset(0 0 0 ${pct}%)`;
}

/** Whether two pictures (or clips) have the same proportions, within `tolerance` (1 %) of the first's. */
export function sameProportions(a: { width: number; height: number }, b: { width: number; height: number }, tolerance = 0.01): boolean {
  if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return true;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / ra <= tolerance;
}

/** «Как в ленте» (§E): the feed sizes a picture is shown at, 16:9, widest first. */
export const FEED_SIZES = [360, 246, 168, 120].map((width) => ({ width, height: Math.floor((width * 9) / 16) }));

/** §F: a clip meant to loop -- any stage row says `metrics.loop` is true (`true` or `"true"`). */
export function loopFromMetrics(stages: ReadonlyArray<{ metrics: Record<string, unknown> }>): boolean {
  return stages.some((s) => s.metrics.loop === true || s.metrics.loop === "true");
}

/** The seam window of a loop clip: a second at each side of the join, at most a quarter of the clip; null for an empty clip. */
export function seamWindowOf(duration: number): number | null {
  if (!(duration > 0)) return null;
  return Math.min(1, duration / 4);
}

/**
 * The seam window plays the last `window` seconds straight into the first (the browser's own loop makes the join): past the
 * first `window` seconds it jumps back to `window` before the end. Null = keep playing.
 */
export function seamJump(time: number, duration: number, window: number): number | null {
  if (!(duration > 2 * window) || !(window > 0)) return null;
  return time > window && time < duration - window ? duration - window : null;
}

/** A loop wrapped from the end to the start -- a fall of more than half the clip (a seek back by the owner is not one). */
export function isWrap(previous: number, time: number, duration: number): boolean {
  return duration > 0 && time < previous - duration / 2;
}

/** The time of a clip's last frame: one frame before its end (the row's or the measured fps, else 1/30 s); never below 0. */
export function lastFrameTime(duration: number, fps: number | null): number {
  return Math.max(0, duration - 1 / (fps && fps > 0 ? fps : 30));
}

/** §E: where a question re-check about a clip opens -- its earliest marker (paused there, so its pin shows); null = none. */
export function questionStart(recheck: { kind: string; markers: ReadonlyArray<{ start: number }> } | null | undefined): number | null {
  if (!recheck || recheck.kind !== "question" || recheck.markers.length === 0) return null;
  return Math.min(...recheck.markers.map((m) => m.start));
}
