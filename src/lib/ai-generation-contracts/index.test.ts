import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Architecture audit 2026-10-01 (M2): the shared AI transport (`ai-connections`) must not depend on
// its consumer features, and the shared contracts module must be a leaf.
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (/\.ts$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("ai-connections imports neither ai-localization, decision-engine nor changesets", async () => {
  for (const file of await sources(path.resolve(process.cwd(), "src/lib/ai-connections"))) {
    const content = await readFile(file, "utf8");
    assert.equal(/@\/lib\/(ai-localization|decision-engine|changesets)\b/.test(content), false, path.basename(file));
  }
});

test("ai-generation-contracts is a leaf: it imports no other @/lib module", async () => {
  for (const file of await sources(path.resolve(process.cwd(), "src/lib/ai-generation-contracts"))) {
    const content = await readFile(file, "utf8");
    assert.equal(/from "@\/lib\//.test(content), false, path.basename(file));
  }
});
