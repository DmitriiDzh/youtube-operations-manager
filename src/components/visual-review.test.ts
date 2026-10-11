import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "@/lib/ui-text";
import { MediaImageViewer } from "./media-image-viewer";
import { MediaVideoPlayer } from "./media-video-player";
import { peerPickItems, peerQueue, reasonLabel, REVIEW_REASONS, reviewKeyAction, screenMedia } from "./plan-review-screen";
import { VisualReviewLayer, type LayerEntry } from "./visual-review-layer";
import {
  attemptLabel,
  FIT,
  fitScale,
  fitView,
  fpsFromMetrics,
  frameAt,
  groupByItem,
  IMAGE_REASONS,
  measuredFps,
  reasonChipsFor,
  regionFromDrag,
  regionToScreen,
  sharedEntryMedia,
  stateOf,
  stepFrame,
  toggleActual,
  totalFromContentRange,
  VIDEO_REASONS,
  viewOf,
  visualKeyAction,
} from "./visual-review-model";

// BL-175 AC-VR-14 (docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §3): the review screen's rules for images and video, stated from the
// plan and FO-REQ-0018 §A-§D (expected values worked out by hand), and a render of each new component without a browser.

const t = createTranslator("en");

test("AC-VR-14 §D: a wave's own chips win, then the plan's, then the media kind's defaults; music keeps its ten", () => {
  const lists = { plan: ["лестница"], groups: { W1: ["лишний фонарь"], W2: [] } };
  assert.deepEqual(reasonChipsFor("image", "W1", lists, REVIEW_REASONS), { source: "custom", values: ["лишний фонарь"] });
  assert.deepEqual(reasonChipsFor("video", "W2", lists, REVIEW_REASONS), { source: "custom", values: ["лестница"] }, "an empty wave list is no list");
  const none = { plan: null, groups: {} };
  assert.deepEqual(reasonChipsFor("image", "W1", none, REVIEW_REASONS), { source: "image", values: IMAGE_REASONS });
  assert.deepEqual(reasonChipsFor("video", null, none, REVIEW_REASONS), { source: "video", values: VIDEO_REASONS });
  assert.deepEqual(reasonChipsFor("audio", "W1", none, REVIEW_REASONS), { source: "audio", values: REVIEW_REASONS });
  assert.equal(IMAGE_REASONS.length, 10);
  assert.equal(VIDEO_REASONS.length, 10);
  assert.deepEqual([IMAGE_REASONS[0], VIDEO_REASONS[0]], ["extra object", "loop seam jump"], "the values DEV-RESP-0021 §2.4 names");
  // A recorded reason reads in the interface language: music, picture defaults, a plan's own chip as written.
  assert.deepEqual([reasonLabel(t, "thin / sparse"), reasonLabel(t, "extra object"), reasonLabel(t, "лестница")], ["thin / sparse", "extra object", "лестница"]);
  assert.equal(reasonLabel(createTranslator("ru"), "extra object"), "лишний предмет");
  assert.equal(reasonLabel(createTranslator("ru"), "loop seam jump"), "шов петли (рывок на стыке)");
});

test("AC-VR-14 §C: a pin is stored as x of the width, y of the height, r of the shorter side -- the same at fit and at 100 %", () => {
  const box = { naturalWidth: 2000, naturalHeight: 1000 };
  const frame = { width: 1000, height: 1000 };
  // Fit: 2000 px wide into 1000 -> scale 0.5, the image 1000 x 500, centred: 250 px from the top.
  const fit = fitView(box, frame);
  assert.deepEqual(fit, { scale: 0.5, offsetX: 0, offsetY: 250 });
  // A press at (500, 500) is the image's centre; a 50 px drag at scale 0.5 is 100 image px = 0.1 of the shorter side (1000).
  assert.deepEqual(regionFromDrag({ x: 500, y: 500 }, { x: 530, y: 540 }, box, fit), { x: 0.5, y: 0.5, r: 0.1 });
  assert.deepEqual(regionToScreen({ x: 0.5, y: 0.5, r: 0.1 }, box, fit), { cx: 500, cy: 500, radius: 50 });
  // 100 % centred: the same region is 100 px across on screen and still at the frame's centre.
  const actual = viewOf({ fit: false, scale: 1, cx: 0.5, cy: 0.5 }, box, frame);
  assert.deepEqual(actual, { scale: 1, offsetX: -500, offsetY: 0 });
  assert.deepEqual(regionToScreen({ x: 0.5, y: 0.5, r: 0.1 }, box, actual), { cx: 500, cy: 500, radius: 100 });
  assert.deepEqual(regionFromDrag({ x: 500, y: 500 }, { x: 560, y: 580 }, box, actual), { x: 0.5, y: 0.5, r: 0.1 });
  // A click alone gives the smallest pin; a press outside the image is kept inside it.
  assert.equal(regionFromDrag({ x: 500, y: 500 }, { x: 500, y: 500 }, box, fit).r, 0.04);
  assert.deepEqual(regionFromDrag({ x: -100, y: 2000 }, { x: -100, y: 2000 }, box, fit), { x: 0, y: 1, r: 0.04 });
  // A small image is shown at its own size when it fits; a video fills its frame.
  assert.equal(fitScale({ naturalWidth: 400, naturalHeight: 300 }, frame), 1);
  assert.equal(fitScale({ naturalWidth: 400, naturalHeight: 300 }, frame, true), 2.5);
});

test("AC-VR-14 §A: Z toggles fit and 100 % around a point; a view state survives a round trip and is shared by two images", () => {
  const box = { naturalWidth: 2000, naturalHeight: 1000 };
  const frame = { width: 1000, height: 1000 };
  const actual = toggleActual(FIT, box, frame);
  assert.deepEqual(actual, { fit: false, scale: 1, cx: 0.5, cy: 0.5 });
  assert.deepEqual(toggleActual(actual, box, frame), FIT);
  // At (0, 250) -- the image's top-left corner at fit -- 100 % keeps that corner under the cursor.
  const corner = toggleActual(FIT, box, frame, { x: 0, y: 250 });
  assert.deepEqual(viewOf(corner, box, frame), { scale: 1, offsetX: 0, offsetY: 250 });
  assert.deepEqual(stateOf(viewOf(corner, box, frame), box, frame), corner);
  // Shared: the same state centres a 1000 x 1000 image on its own centre too.
  assert.deepEqual(viewOf(actual, { naturalWidth: 1000, naturalHeight: 1000 }, frame), { scale: 1, offsetX: 0, offsetY: 0 });
});

test("AC-VR-14 §A: frames -- metrics.fps first; measured from presented frames; frame numbers and steps stay inside the clip", () => {
  assert.equal(fpsFromMetrics([{ metrics: { fps: 16 } }, { metrics: { lufs: -14 } }]), 16);
  assert.equal(fpsFromMetrics([{ metrics: { fps: "16" } }]), null, "a number only");
  assert.equal(fpsFromMetrics([{ metrics: {} }]), null);
  const at16 = Array.from({ length: 12 }, (_, i) => i / 16);
  assert.equal(measuredFps(at16), 16);
  assert.equal(measuredFps(Array.from({ length: 12 }, (_, i) => i * (1001 / 24000))), 23.976);
  assert.equal(measuredFps(at16.slice(0, 5)), null, "too few frames");
  // Frame numbers count from 1: at 16 fps, 0 s is frame 1 and 1.0 s is frame 17.
  assert.deepEqual([frameAt(0, 16), frameAt(1, 16), frameAt(0.999, 16)], [1, 17, 16]);
  // A step goes to the middle of the next frame; never before the first or past the last (5 s at 16 fps: frames 0..79).
  assert.equal(stepFrame(1, 16, 1, 5), 17.5 / 16);
  assert.equal(stepFrame(0, 16, -1, 5), 0.5 / 16);
  assert.equal(stepFrame(4.99, 16, 1, 5), 79.5 / 16);
});

test("AC-VR-14: the grid groups by item in the walk's order; an attempt without a seed is named by its ref", () => {
  const e = (itemKey: string, attemptRef: string, seed: number | null = null) => ({ itemKey, attemptRef, seed });
  assert.deepEqual(
    groupByItem([e("W1/A", "a1"), e("W1/B", "b1"), e("W1/A", "a2")]).map((g) => [g.itemKey, g.entries.map((x) => x.attemptRef)]),
    [
      ["W1/A", ["a1", "a2"]],
      ["W1/B", ["b1"]],
    ]
  );
  assert.deepEqual([attemptLabel(e("I", "a3")), attemptLabel(e("I", "job:9392c436-0568", 2007)), attemptLabel(e("I", "job:9392c436-0568"))], ["a3", "2007", "9392c436"]);
});

test("AC-VR-14: the keys only pictures have; the music map is unchanged (Enter, Z, G, S, C, comma and period do nothing there)", () => {
  assert.deepEqual(["z", "Z", ",", ".", "g", "Enter", "C", "s", "Escape", "x"].map(visualKeyAction), ["zoom", "zoom", "frameBack", "frameForward", "grid", "loupe", "compare", "pick", "close", null]);
  for (const key of ["Enter", "z", "g", "s", "c", ",", "."]) assert.equal(reviewKeyAction(key), null, key);
});

test("AC-VR-14: an image's size comes from Content-Range; the media kind of another computer's entry and of a revision", () => {
  assert.equal(totalFromContentRange("bytes 0-0/2205114"), 2205114);
  assert.equal(totalFromContentRange(null), null);
  assert.equal(sharedEntryMedia({ stages: [{ auditionFile: "a.mp3" }, { auditionFile: "H/a1.png" }], jobOutput: null }), "image");
  assert.equal(sharedEntryMedia({ currentFile: "loop2/fixed.mp4", stages: [{ auditionFile: "H/a1.png" }] }), "video");
  assert.equal(sharedEntryMedia({ stages: [{ auditionFile: null }], jobOutput: "media/j1/x_00001.webp" }), "image");
  assert.equal(screenMedia({ media: "image", recheck: { kind: "revision", auditionFile: "H/a1__r1.mp4" } }), "video");
  assert.equal(screenMedia({ media: "audio" }), "audio");
});

/** Another computer's (v5) report of a visual plan: item I (fixed, pick target 1), attempts a1..a3 with PNGs. */
function peerData(extra: Record<string, unknown> = {}) {
  const entry = (attemptRef: string) => ({
    itemKey: "W1/I",
    groupId: "W1",
    attemptRef,
    jobId: null,
    seed: null,
    params: {},
    stages: [{ stageId: "render", itemKey: "W1/I", attemptRef, result: "done" as const, reportedBy: "factory" as const, note: null, rating: null, reasons: [], markers: [], auditionFile: `H/${attemptRef}.png`, checks: [], metrics: {}, at: "2026-10-11T10:00:00.000Z" }],
    verdict: null,
    playable: true,
    validator: null,
  });
  return {
    devices: [
      {
        deviceId: "mac-id",
        hostname: "MAC",
        plans: [{ planId: "H", review: [entry("a1"), entry("a2"), entry("a3")], items: [{ itemKey: "W1/I", groupId: "W1", mode: "fixed" as const, targetCount: 1, pickTarget: 1 }], picks: [], noneFits: [], handledPicks: [], ...extra }],
      },
    ],
    outgoing: [],
  };
}

test("AC-VR-14 §2.6: on Windows a pick sent from here settles the item at once (picked, sent; the others not chosen); once weighed there it is the report's", () => {
  const source = { deviceId: "mac-id", hostname: "MAC" };
  const sent = { pickId: "p-1", ownerDeviceId: "mac-id", planId: "H", itemKey: "W1/I", attemptRef: "a2", action: "pick" as const, note: null, at: "2026-10-11T10:05:00.000Z" };
  const queue = peerQueue({ ...peerData(), outgoingPicks: [sent] }, source, "H");
  assert.deepEqual(queue.map((e) => [e.attemptRef, e.media, Boolean(e.picked), e.pickSent ?? false, e.notChosen ?? false]), [
    ["a1", "image", false, false, true],
    ["a2", "image", true, true, false],
    ["a3", "image", false, false, true],
  ]);
  const handled = peerQueue({ ...peerData({ handledPicks: ["p-1"] }), outgoingPicks: [sent] }, source, "H");
  assert.deepEqual(handled.map((e) => [Boolean(e.picked), e.notChosen ?? false]), [[false, false], [false, false], [false, false]], "weighed there: the report decides");
  // A "none fits" sent from here shows on the item until that device weighed it.
  const nf = { ...sent, pickId: "p-2", attemptRef: null, action: "none_fits" as const, note: "все с фонарём" };
  assert.deepEqual(peerPickItems({ ...peerData(), outgoingPicks: [nf] }, source, "H").get("W1/I"), { pickTarget: 1, noneFits: { note: "все с фонарём", device: "", at: nf.at, attempts: 0, sent: true } });
  assert.deepEqual(peerPickItems({ ...peerData({ handledPicks: ["p-2"] }), outgoingPicks: [nf] }, source, "H").get("W1/I"), { pickTarget: 1, noneFits: null });
});

// -- renders without a browser (each new component, representative props) ----------------------------------------------------

const layerEntry = (n: number, media: "image" | "video", over: Partial<LayerEntry> = {}): LayerEntry => ({
  key: `W1/I\u0000a${n}`,
  itemKey: "W1/I",
  attemptRef: `a${n}`,
  seed: null,
  media,
  verdict: null,
  validator: "passed",
  fullSrc: `/api/generation-plans/H/audition?itemKey=W1%2FI&attemptRef=a${n}`,
  previewSrc: media === "image" ? `/api/generation-plans/H/preview?itemKey=W1%2FI&attemptRef=a${n}` : null,
  fps: 16,
  pins: [],
  markers: [],
  ...over,
});
const layerProps = (mode: "grid" | "loupe" | "compare", entries: LayerEntry[]) => ({
  mode,
  scope: "item" as const,
  onScope: () => undefined,
  entries,
  currentKey: entries[0].key,
  compareKey: entries[1]?.key ?? null,
  blind: false,
  shortKey: (k: string) => k,
  itemPicks: () => ({ picked: 1, target: 1, noneFits: false }),
  pickBlocked: () => null,
  busy: false,
  onSelect: () => undefined,
  onToggleCompare: () => undefined,
  onMode: () => undefined,
  onPick: () => undefined,
  onNoneFits: () => undefined,
  onClose: () => undefined,
});

test("AC-VR-14: the grid of 8 images renders a preview, a pick button and the item's count each; not chosen ones say so", () => {
  const entries = Array.from({ length: 8 }, (_, i) => layerEntry(i + 1, "image", i === 2 ? { picked: { device: "MAC", at: "2026-10-11T10:00:00.000Z", note: null } } : { notChosen: true }));
  const html = renderToStaticMarkup(createElement(VisualReviewLayer, layerProps("grid", entries)));
  assert.equal((html.match(/\/preview\?itemKey=W1%2FI&amp;attemptRef=a\d/g) ?? []).length, 8);
  assert.match(html, /Picked 1 of 1/);
  assert.equal((html.match(/not chosen/g) ?? []).length, 7);
  assert.match(html, /None of these fits/);
  assert.equal((html.match(/loading="lazy"/g) ?? []).length, 8, "previews load lazily");
});

test("AC-VR-14: the loupe shows one image at full size; compare shows two clips side by side; the players render their controls", () => {
  const loupe = renderToStaticMarkup(createElement(VisualReviewLayer, layerProps("loupe", [layerEntry(1, "image"), layerEntry(2, "image")])));
  assert.match(loupe, /audition\?itemKey=W1%2FI&amp;attemptRef=a1/);
  const compare = renderToStaticMarkup(createElement(VisualReviewLayer, layerProps("compare", [layerEntry(1, "video"), layerEntry(2, "video")])));
  assert.equal((compare.match(/<video/g) ?? []).length, 2);
  const image = renderToStaticMarkup(createElement(MediaImageViewer, { src: "/x.png", pins: [{ region: { x: 0.5, y: 0.5, r: 0.1 }, label: "1", tone: "mark" }], onAddPin: () => undefined, bytes: 2_205_114 }));
  assert.match(image, /<img[^>]*src="\/x.png"/);
  assert.match(image, /Fit · 100 %/);
  assert.match(image, /2\.1 MB/);
  const video = renderToStaticMarkup(createElement(MediaVideoPlayer, { src: "/x.mp4", markers: [{ start: 1, end: 2, label: "1. фонарь", tone: "mark" }], fps: 16 }));
  assert.match(video, /<video[^>]*loop/);
  assert.match(video, /<video[^>]*muted/);
  for (const text of ["0.25×", "0.5×", "1×", "2×", "Sound off", "frame 1 · 16 fps"]) assert.ok(video.includes(text), text);
});
