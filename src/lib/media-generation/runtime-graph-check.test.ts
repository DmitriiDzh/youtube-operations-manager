import assert from "node:assert/strict";
import test from "node:test";
import { blockingIssues, checkGraphInputs, compactNodeInfo } from "./runtime-graph-check";

// FO-REQ-0030 (BL-201). Expected values come from the request and ComfyUI's `/object_info` format: a node's `input.required` /
// `optional` / `hidden` map each input to [TYPE, opts] or [[values], opts] (newer builds: ["COMBO", { options }]). The live case:
// ComfyUI 0.41.0 made `resolution_steps` a required input of `ImageScaleToTotalPixels`, and `p3-flux3-klein-edit` v2 did not set
// it (HTTP 400 required_input_missing at /prompt, 2026-10-18).

const OBJECT_INFO = {
  ImageScaleToTotalPixels: {
    input: {
      required: {
        image: ["IMAGE"],
        upscale_method: [["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]],
        megapixels: ["FLOAT", { default: 1, min: 0.01, max: 16, step: 0.01 }],
        resolution_steps: ["INT", { default: 1, min: 1, max: 256 }],
      },
    },
    output: ["IMAGE"],
    description: "dropped by compactNodeInfo",
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { min: 0, max: 18446744073709552000 }],
        steps: ["INT", { min: 1, max: 10000 }],
        cfg: ["FLOAT", { min: 0, max: 100 }],
        sampler_name: ["COMBO", { options: ["euler", "dpmpp_2m"] }],
        scheduler: [["normal", "karras"]],
        denoise: ["FLOAT", { min: 0, max: 1 }],
      },
    },
  },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model-a.safetensors"]] } } },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] }, hidden: { prompt: "PROMPT", extra_pnginfo: "EXTRA_PNGINFO" } } },
  LoadImage: { input: { required: { image: [["a.png", "b.png"], { image_upload: true }] } } },
  ToggleNode: { input: { required: {}, optional: { enabled: ["BOOLEAN"] } } },
};
const info = compactNodeInfo(OBJECT_INFO);
const graph = (nodes: Record<string, unknown>) => JSON.stringify(nodes);

test("FO-REQ-0030 acceptance: v2 of p3-flux3-klein-edit lacks resolution_steps on ImageScaleToTotalPixels; v3 sets it and is clean", () => {
  const v2 = graph({
    "11": { class_type: "LoadImage", inputs: { image: "input.png" } },
    "12": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["11", 0], upscale_method: "lanczos", megapixels: 1 } },
  });
  const params = new Set(["11.image"]);
  assert.deepEqual(checkGraphInputs(v2, info, params), [{ nodeId: "12", classType: "ImageScaleToTotalPixels", input: "resolution_steps", problem: "required_missing" }]);
  const v3 = graph({
    "11": { class_type: "LoadImage", inputs: { image: "input.png" } },
    "12": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["11", 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 } },
  });
  assert.deepEqual(checkGraphInputs(v3, info, params), []);
});

test("a required input filled by a template parameter at job time counts as set, and its placeholder value is not checked", () => {
  const g = graph({ "3": { class_type: "KSampler", inputs: { model: ["4", 0], steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 } } });
  assert.deepEqual(checkGraphInputs(g, info), [{ nodeId: "3", classType: "KSampler", input: "seed", problem: "required_missing" }]);
  assert.deepEqual(checkGraphInputs(g, info, new Set(["3.seed"])), []);
  const placeholder = graph({ "3": { class_type: "KSampler", inputs: { model: ["4", 0], seed: -1, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 } } });
  assert.deepEqual(checkGraphInputs(placeholder, info, new Set(["3.seed"])), []);
});

test("list values (old list form and COMBO options), INT/FLOAT ranges and types, BOOLEAN type", () => {
  const g = graph({
    "3": { class_type: "KSampler", inputs: { model: ["4", 0], seed: 1, steps: 0, cfg: "7", sampler_name: "euler_ancestral", scheduler: "exponential", denoise: 1.5 } },
    "5": { class_type: "ToggleNode", inputs: { enabled: "yes" } },
  });
  const issues = checkGraphInputs(g, info);
  const by = (input: string) => issues.find((i) => i.input === input);
  assert.deepEqual(by("steps"), { nodeId: "3", classType: "KSampler", input: "steps", problem: "out_of_range", allowed: { min: 1, max: 10000 } });
  assert.equal(by("cfg")?.problem, "bad_value");
  assert.deepEqual(by("sampler_name"), { nodeId: "3", classType: "KSampler", input: "sampler_name", problem: "bad_value", allowed: ["euler", "dpmpp_2m"] });
  assert.deepEqual(by("scheduler")?.allowed, ["normal", "karras"]);
  assert.equal(by("denoise")?.problem, "out_of_range");
  assert.equal(by("enabled")?.problem, "bad_value");
  assert.equal(by("seed"), undefined);
  assert.equal(issues.length, 6);
});

test("unknown inputs are warnings (not blocking); hidden inputs are not unknown; links and model / media file lists are not value-checked", () => {
  const g = graph({
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux3/other-model.safetensors" } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out", prompt: "x", old_input: 1 } },
    "11": { class_type: "LoadImage", inputs: { image: "photo.jpg" } },
    "99": { class_type: "NodeTheRuntimeLacks", inputs: { anything: 1 } },
  });
  const issues = checkGraphInputs(g, info);
  assert.deepEqual(issues, [{ nodeId: "9", classType: "SaveImage", input: "old_input", problem: "unknown_input" }]);
  assert.deepEqual(blockingIssues(issues), []);
});

test("an unreadable graph has no input issues (it is reported elsewhere); compactNodeInfo keeps only the inputs", () => {
  assert.deepEqual(checkGraphInputs("not json", info), []);
  assert.deepEqual(Object.keys(info.ImageScaleToTotalPixels), ["required", "optional", "hidden"]);
});
