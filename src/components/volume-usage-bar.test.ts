import assert from "node:assert/strict";
import test from "node:test";
import { GIB, volumeUsageBreakdown } from "./volume-usage-bar";

// BL-136 (owner, Telegram 2026-10-06, msg 1709): the Models tab's space bar shows the rented size, the used space and how much
// each model takes. Expected values are worked out by hand from that requirement (GB = 1024^3 bytes, as the rest of the panel).

const m = (key: string, gb: number) => ({ key, name: key.split("/").pop()!, bytes: gb * GIB });

test("each model is a segment, the rest of models/ and the non-model files are folded, free = rented - used", () => {
  const b = volumeUsageBreakdown({
    rentedGb: 50,
    models: [m("models/checkpoints/b.safetensors", 10), m("models/checkpoints/a.safetensors", 5), m("models/vae/c.safetensors", 1)],
    usage: { totalBytes: 19 * GIB + 1024, modelsBytes: 16 * GIB + 1024, exchangeBytes: 2 * GIB, otherBytes: GIB, objectCount: 9 },
  });
  assert.equal(b.rentedBytes, 50 * GIB);
  assert.equal(b.usedBytes, 19 * GIB + 1024);
  assert.equal(b.freeBytes, 31 * GIB - 1024);
  assert.equal(b.overBytes, 0);
  assert.equal(b.complete, true);
  assert.deepEqual(
    b.segments.map((s) => [s.id, s.bytes, s.kind]),
    [
      ["models/checkpoints/a.safetensors", 5 * GIB, "model"],
      ["models/checkpoints/b.safetensors", 10 * GIB, "model"],
      ["models/vae/c.safetensors", GIB, "model"],
      ["other-models", 1024, "other-models"], // the HF cache / folder markers under models/ take space too
      ["other-files", 3 * GIB, "other-files"],
    ]
  );
  // Three distinct model colors, none of them the folded segments' grays.
  const colors = b.segments.map((s) => s.color);
  assert.equal(new Set(colors.slice(0, 3)).size, 3);
  assert.ok(!colors.slice(0, 3).includes(colors[3]) && !colors.slice(0, 3).includes(colors[4]));
});

test("only the five largest models get their own segment; the two smallest fold into Other models", () => {
  const models = [1, 2, 3, 4, 5, 6, 7].map((gb) => m(`models/checkpoints/m${gb}.safetensors`, gb));
  const b = volumeUsageBreakdown({ rentedGb: 100, models, usage: { totalBytes: 28 * GIB, modelsBytes: 28 * GIB, exchangeBytes: 0, otherBytes: 0, objectCount: 7 } });
  assert.deepEqual(
    b.segments.map((s) => [s.label, s.bytes / GIB]),
    [["m3.safetensors", 3], ["m4.safetensors", 4], ["m5.safetensors", 5], ["m6.safetensors", 6], ["m7.safetensors", 7], ["Other models", 3]]
  );
  assert.equal(b.freeBytes, 72 * GIB);
});

test("a model keeps its color when a smaller model is added to the shown set's tail (colors by key, not by rank)", () => {
  const before = volumeUsageBreakdown({ rentedGb: 50, models: [m("models/a/x.safetensors", 1), m("models/a/y.safetensors", 9)], usage: null });
  const after = volumeUsageBreakdown({ rentedGb: 50, models: [m("models/a/x.safetensors", 1), m("models/a/y.safetensors", 9), m("models/b/z.safetensors", 2)], usage: null });
  const color = (b: typeof before, id: string) => b.segments.find((s) => s.id === id)?.color;
  assert.equal(color(after, "models/a/x.safetensors"), color(before, "models/a/x.safetensors"));
  assert.equal(color(after, "models/a/y.safetensors"), color(before, "models/a/y.safetensors"));
});

test("without the whole-volume listing, used is the model files only and the breakdown says it is incomplete", () => {
  const b = volumeUsageBreakdown({ rentedGb: 50, models: [m("models/a/x.safetensors", 4)], usage: null });
  assert.equal(b.usedBytes, 4 * GIB);
  assert.equal(b.freeBytes, 46 * GIB);
  assert.equal(b.complete, false);
  assert.deepEqual(b.segments.map((s) => s.kind), ["model"]);
});

test("used beyond the rented size is reported as over, free is 0; an empty volume is all free", () => {
  const over = volumeUsageBreakdown({ rentedGb: 10, models: [m("models/a/x.safetensors", 12)], usage: null });
  assert.equal(over.freeBytes, 0);
  assert.equal(over.overBytes, 2 * GIB);
  const empty = volumeUsageBreakdown({ rentedGb: 10, models: [], usage: { totalBytes: 0, modelsBytes: 0, exchangeBytes: 0, otherBytes: 0, objectCount: 0 } });
  assert.deepEqual(empty.segments, []);
  assert.equal(empty.freeBytes, 10 * GIB);
});
