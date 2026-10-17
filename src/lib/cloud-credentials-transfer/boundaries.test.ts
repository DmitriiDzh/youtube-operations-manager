import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-193 (AGENTS.md §M, ADR 0039 §6): the cloud-keys file is shared logic in its own module. Its file logic knows no provider (only
// `index.ts` wires the feature modules, through their barrels), and neither feature module knows the shared module exists.

const lib = path.join(process.cwd(), "src", "lib");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("the file logic imports no feature module; only index.ts wires media-generation and gemini-media, through their barrels", async () => {
  for (const name of ["contracts.ts", "services.ts"]) {
    const text = await readFile(path.join(lib, "cloud-credentials-transfer", name), "utf8");
    assert.doesNotMatch(text, /@\/lib\/(media-generation|gemini-media)/, name);
  }
  const index = await readFile(path.join(lib, "cloud-credentials-transfer", "index.ts"), "utf8");
  assert.doesNotMatch(index, /@\/lib\/(media-generation|gemini-media)\//, "barrels only");
});

test("media-generation and gemini-media do not import the shared transfer module", async () => {
  const offenders: string[] = [];
  for (const name of ["media-generation", "gemini-media"]) {
    for (const file of await sourceFiles(path.join(lib, name))) {
      if (/@\/lib\/cloud-credentials-transfer/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
    }
  }
  assert.deepEqual(offenders, []);
});
