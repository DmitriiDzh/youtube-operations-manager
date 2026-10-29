import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-174 / BL-193: Chrome filled a saved login password into a type="password" API-key field (2026-10-11) and would have sent it
// to the provider. Every secret field of Settings → Cloud APIs (RunPod key, S3 secret, Gemini key, the key-file passwords) is a
// MaskedSecretInput, never a password field.
// BL-236: + the ElevenLabs key.
const CLOUD_API_TAB_FILES = ["media-generation-settings.tsx", "gemini-media-settings.tsx", "elevenlabs-settings.tsx", "cloud-credentials-transfer.tsx"];

test("no secret field of the Cloud APIs tab is type=\"password\"; each one uses MaskedSecretInput", async () => {
  for (const file of CLOUD_API_TAB_FILES) {
    const source = await readFile(path.join(process.cwd(), "src", "components", file), "utf8");
    assert.doesNotMatch(source, /type=["{]+password/, file);
    assert.match(source, /<MaskedSecretInput\b/, file);
  }
});
