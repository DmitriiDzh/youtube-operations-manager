import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-236 (ADR 0057, AGENTS.md §M): elevenlabs-speech is independent -- no other feature module (gemini-media, media-generation,
// generation-plans) and ElevenLabs only through @/lib/media-gateway; no direct network call.

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("elevenlabs-speech imports no other feature module and makes no direct network call", async () => {
  const lib = path.join(process.cwd(), "src", "lib");
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "elevenlabs-speech"))) {
    const text = await readFile(file, "utf8");
    if (/from\s+["']@\/lib\/(gemini-media|media-generation|generation-plans)(\/|["'])/.test(text)) offenders.push(path.relative(lib, file));
    if (/fetch\(|elevenlabs\.io/.test(text)) offenders.push(`${path.relative(lib, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("gemini-media and the voice registry do not import elevenlabs-speech", async () => {
  const lib = path.join(process.cwd(), "src", "lib");
  const offenders: string[] = [];
  for (const name of ["gemini-media", "voice-registry"]) {
    for (const file of await sourceFiles(path.join(lib, name))) if (/from\s+["']@\/lib\/elevenlabs-speech/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
  }
  assert.deepEqual(offenders, []);
});
