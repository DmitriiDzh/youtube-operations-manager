import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createElevenlabsApiClient } from "./elevenlabs-api";
import { createGeminiApiClient } from "./gemini-api";

// BL-236 (owner, Telegram 2026-10-29 msg 3816: "designed voices only, no cloning anywhere"; R-0005 §4 legal line): no gateway child
// may expose a function that clones or replicates a voice from recorded audio, nor reach the providers' cloning endpoints.

const CLONE_NAME = /clone|replicat|voicesadd|addvoice|speechtospeech|ivc|pvc/i;
const CLONE_ENDPOINT = /\/v1\/voices\/add|\/v1\/speech-to-speech|voice-cloning|"replicated"|type:\s*"replicated"/;

test("the speech gateways expose no clone / replicate function", () => {
  const gemini = Object.keys(createGeminiApiClient({ fetchImpl: (async () => new Response()) as typeof fetch, authorize: async () => undefined }));
  const elevenlabs = Object.keys(createElevenlabsApiClient({ fetchImpl: (async () => new Response()) as typeof fetch, authorize: async () => undefined }));
  assert.deepEqual([...gemini, ...elevenlabs].filter((name) => CLONE_NAME.test(name)), []);
  assert.ok(gemini.includes("designVoice") && elevenlabs.includes("designVoice"), "designing from a description is what they offer");
});

test("no production source reaches a voice-cloning endpoint", async () => {
  async function list(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await list(full)));
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
    }
    return out;
  }
  const offenders: string[] = [];
  for (const file of await list(path.join(process.cwd(), "src"))) if (CLONE_ENDPOINT.test(await readFile(file, "utf8"))) offenders.push(path.relative(process.cwd(), file));
  assert.deepEqual(offenders, []);
});
