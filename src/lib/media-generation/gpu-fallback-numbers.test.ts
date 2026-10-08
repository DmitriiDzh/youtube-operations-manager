import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEDIA_SETTINGS } from "./contracts";
import { mediaSettingsSchema } from "./schemas";

// Owner, Telegram 2026-10-08 (msg 2091): the fallback list was typed as a numbered list ("1. NVIDIA GeForce RTX 4090"), which
// matches no RunPod catalog id, so every fallback GPU was skipped. The number is not part of a GPU id.
test("a numbered fallback list keeps only the GPU ids, on save and when read back", () => {
  const parsed = mediaSettingsSchema.parse({ ...DEFAULT_MEDIA_SETTINGS, gpuFallbackIds: ["1. NVIDIA GeForce RTX 4090", "2) NVIDIA RTX A5000", "10.NVIDIA L4", "NVIDIA A40"] });
  assert.deepEqual(parsed.gpuFallbackIds, ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA L4", "NVIDIA A40"]);
  // A real id is never cut: RunPod ids do not start with a number followed by "." or ")".
  assert.deepEqual(mediaSettingsSchema.parse({ ...DEFAULT_MEDIA_SETTINGS, gpuFallbackIds: ["NVIDIA RTX 6000 Ada Generation"] }).gpuFallbackIds, ["NVIDIA RTX 6000 Ada Generation"]);
  assert.equal(mediaSettingsSchema.safeParse({ ...DEFAULT_MEDIA_SETTINGS, gpuFallbackIds: ["3. "] }).success, false, "a bare number is not an id");
});
