import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-278 stage 1 (VIDIQ_INTEGRATION_PLAN.md §5 "Settings card", AC-VQ-1.18): the vidIQ card in Settings → Cloud APIs, in its own
// FeatureErrorBoundary; the key is a MaskedSecretInput, the switch a ToggleSwitch with a visible label; the card talks only to the
// /api/vidiq routes and imports nothing of the module at run time (no server code in the browser bundle).

const read = (rel: string) => readFile(path.join(process.cwd(), "src", rel), "utf8");

test("the card uses MaskedSecretInput for the key and ToggleSwitch with a visible label for the switch", async () => {
  const source = await read("components/vidiq-settings.tsx");
  assert.match(source, /<MaskedSecretInput\b/);
  assert.doesNotMatch(source, /type=["{]+password/);
  assert.match(source, /<ToggleSwitch\b/);
  assert.match(source, /t\("vidiq\.switch\.label"\)/, "a visible label next to the switch");
  assert.match(source, /["'`]\/api\/vidiq/);
});

test("the card imports nothing from the module or the gateway at run time", async () => {
  const source = await read("components/vidiq-settings.tsx");
  for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*from\s+["']@\/lib\/(vidiq-research|vidiq-gateway)[^"']*["']/gm)) {
    assert.ok(match[1], `a value import: ${match[0]}`);
  }
});

test("Settings → Cloud APIs renders the card inside its own FeatureErrorBoundary", async () => {
  const layout = await read("app/(app)/settings/layout.tsx");
  assert.match(layout, /<FeatureErrorBoundary label=\{section\("vidiq\.title"\)\}>\s*<VidiqSettings \/>\s*<\/FeatureErrorBoundary>/);
});
