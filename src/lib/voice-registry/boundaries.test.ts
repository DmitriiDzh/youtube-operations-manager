import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-236 (ADR 0057, AGENTS.md §M): the voice registry is shared -- it imports no speech provider (they are injected as ports) and
// makes no network call of its own.

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("voice-registry imports neither gemini-media nor elevenlabs-speech nor the media gateway, and calls no network", async () => {
  const lib = path.join(process.cwd(), "src", "lib");
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "voice-registry"))) {
    const text = await readFile(file, "utf8");
    if (/from\s+["']@\/lib\/(gemini-media|elevenlabs-speech|media-gateway)(\/|["'])/.test(text)) offenders.push(path.relative(lib, file));
    if (/fetch\(|googleapis|elevenlabs\.io/.test(text)) offenders.push(`${path.relative(lib, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});
