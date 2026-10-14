import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiRequest, catalogEstimateUsd, isRelativeInputPath, type GeminiCatalogModel, type GeminiFormState } from "./gemini-media-create-request";

// BL-188 stage 4 (owner msg 2806 Q3): Media's Gemini form -> the Gemini module's request (GEMINI_MEDIA_PLAN.md §2.5 rules the
// form can know: a model of the tab's kind, a setting the model offers, 4/6/8 s, frames only on a model that takes them, a last
// frame only with a first, storyboard + segment together, relative paths). Prices from the catalog the server sends.

const catalog: GeminiCatalogModel[] = [
  { model: "img-a", kind: "image", label: "Image A", sizes: ["1K", "2K"], usdPerImage: { "1K": 0.04, "2K": 0.06 } },
  { model: "vid-frames", kind: "video", label: "Video frames", resolutions: ["720p", "1080p"], usdPerSecond: { "720p": 0.1, "1080p": 0.15 }, referenceImages: false, frames: true, retiresOn: null },
  { model: "vid-refs", kind: "video", label: "Video refs", resolutions: ["720p"], usdPerSecond: { "720p": 0.4 }, referenceImages: true, frames: false, retiresOn: "2026-10-22" },
];

const form = (extra: Partial<GeminiFormState> = {}): GeminiFormState => ({
  model: "img-a",
  prompt: "  a tea house  ",
  size: "1K",
  aspectRatio: "16:9",
  referenceImages: "",
  resolution: "720p",
  durationSeconds: 8,
  firstFrame: "",
  lastFrame: "",
  storyboardId: "",
  segmentId: "",
  ...extra,
});

test("an image request: trimmed prompt, size and aspect; reference images one per line, blank lines ignored", () => {
  assert.deepEqual(buildGeminiRequest("image", form(), catalog), { ok: true, request: { kind: "image", model: "img-a", prompt: "a tea house", image: { size: "1K", aspectRatio: "16:9" } } });
  const withRefs = buildGeminiRequest("image", form({ referenceImages: "refs/a.png\n\n  refs/b.jpg \n" }), catalog);
  assert.ok(withRefs.ok);
  assert.deepEqual(withRefs.request.image?.inputs, { images: ["refs/a.png", "refs/b.jpg"] });
});

test("image refusals: model of another kind, empty prompt, size the model lacks, unknown aspect, 15 references, a bad path", () => {
  const problem = (k: "image" | "video", f: GeminiFormState) => {
    const r = buildGeminiRequest(k, f, catalog);
    return r.ok ? null : r.problem;
  };
  assert.equal(problem("image", form({ model: "vid-frames" })), "model");
  assert.equal(problem("image", form({ prompt: "   " })), "prompt");
  assert.equal(problem("image", form({ prompt: "x".repeat(10_001) })), "prompt");
  assert.equal(problem("image", form({ size: "4K" })), "size");
  assert.equal(problem("image", form({ aspectRatio: "7:5" })), "aspectRatio");
  assert.equal(problem("image", form({ referenceImages: Array.from({ length: 15 }, (_, i) => `r/${i}.png`).join("\n") })), "references");
  assert.equal(problem("image", form({ referenceImages: Array.from({ length: 14 }, (_, i) => `r/${i}.png`).join("\n") })), null);
  for (const bad of ["/abs/x.png", "../x.png", "a/../x.png", "C:/x.png", "a\\b.png", "a//b.png"]) assert.equal(problem("image", form({ referenceImages: bad })), "path", bad);
});

test("a video request: first + last frame and a storyboard segment on a model that takes frames", () => {
  const r = buildGeminiRequest("video", form({ model: "vid-frames", resolution: "1080p", aspectRatio: "9:16", durationSeconds: 6, firstFrame: "bar/K0.jpg", lastFrame: "bar/K1.jpg", storyboardId: "bar-loop", segmentId: "S1" }), catalog);
  assert.deepEqual(r, {
    ok: true,
    request: { kind: "video", model: "vid-frames", prompt: "a tea house", video: { resolution: "1080p", aspectRatio: "9:16", durationSeconds: 6, inputs: { firstFrame: "bar/K0.jpg", lastFrame: "bar/K1.jpg" } }, storyboardId: "bar-loop", segmentId: "S1" },
  });
});

test("video refusals follow the model rules the form can know", () => {
  const problem = (f: GeminiFormState) => {
    const r = buildGeminiRequest("video", f, catalog);
    return r.ok ? null : r.problem;
  };
  const v = (extra: Partial<GeminiFormState>) => form({ model: "vid-frames", aspectRatio: "16:9", ...extra });
  assert.equal(problem(v({ resolution: "4k" })), "resolution");
  assert.equal(problem(v({ aspectRatio: "1:1" })), "aspectRatio");
  assert.equal(problem(v({ durationSeconds: 5 })), "duration");
  assert.equal(problem(v({ lastFrame: "b.jpg" })), "lastFrame");
  assert.equal(problem(v({ model: "vid-refs", firstFrame: "a.jpg" })), "frames");
  assert.equal(problem(v({ referenceImages: "r.png" })), "references", "this model takes no reference images");
  assert.equal(problem(v({ model: "vid-refs", referenceImages: "a.png\nb.png\nc.png\nd.png" })), "references");
  assert.equal(problem(v({ model: "vid-refs", referenceImages: "a.png\nb.png\nc.png" })), null);
  assert.equal(problem(v({ storyboardId: "bar-loop" })), "storyboard");
  assert.equal(problem(v({ segmentId: "S1" })), "storyboard");
  assert.equal(problem(v({ storyboardId: "bar loop", segmentId: "S1" })), "storyboard");
  assert.equal(problem(v({ firstFrame: "../K0.jpg" })), "path");
});

test("the price list's figure: one image of the size, or seconds × the resolution's price (rounded up to 1/10000 $)", () => {
  const image = buildGeminiRequest("image", form({ size: "2K" }), catalog);
  assert.ok(image.ok);
  assert.equal(catalogEstimateUsd(image.request, catalog), 0.06);
  const video = buildGeminiRequest("video", form({ model: "vid-frames", resolution: "720p", durationSeconds: 6 }), catalog);
  assert.ok(video.ok);
  assert.equal(catalogEstimateUsd(video.request, catalog), 0.6);
  assert.equal(catalogEstimateUsd({ kind: "image", model: "unknown", prompt: "x", image: { size: "1K", aspectRatio: "1:1" } }, catalog), null);
});

test("isRelativeInputPath", () => {
  assert.equal(isRelativeInputPath("folder/file.png"), true);
  for (const bad of ["", "/x", "..", "a/./b", "C:\\x", "x".repeat(501)]) assert.equal(isRelativeInputPath(bad), false, bad);
});
