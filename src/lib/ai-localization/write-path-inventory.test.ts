// ---------------------------------------------------------------------------
// AC-SAFETY-01 + AC-COST-01 (docs/acceptance/PHASE_6_ACCEPTANCE.md).
//
// Mirrors src/lib/batches/write-path-inventory.test.ts's pattern: a structural,
// automated inventory check rather than a one-time manual grep, so a future change
// that introduces a real AI provider network call or a real-YouTube-write reference
// inside src/lib/ai-localization/** fails the build immediately.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = THIS_DIR;

async function listTsFilesRecursively(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

// AC-SAFETY-01: no reference to any Phase 5 live-write-capable symbol anywhere in
// this module (this module should never need to know these names exist).
// Note: the real WriteExecutor factory's name is deliberately not listed here -- it is
// already covered repo-wide by src/lib/batches/write-path-inventory.test.ts's own
// whitelist check, which would otherwise flag this very file for containing that
// exact string literal.
const FORBIDDEN_WRITE_SYMBOLS = [
  "executeBatch",
  "executeWithRetry",
  "recoverBatch",
  "resolveUnknownLedgerRow",
  "WriteExecutor",
  "createScriptedFakeWriteExecutor",
  "performYoutubeWrite",
  "assertLiveWritesAuthorized",
];

/**
 * Strips single-line (`//`) and block (`/* ... *\/`) comments before scanning, so a
 * doc comment merely *naming* a future possible provider (docs/PROJECT_SPEC.md §32
 * lists OpenAI/Anthropic/DeepL/Google Translation as future options) never trips
 * this check -- only an actual import/require of such a package, or a real network
 * call, counts as a violation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// AC-COST-01: no *import or call* referencing a real AI provider SDK or a generic
// HTTP/network client (comments naming these as future options are fine and expected
// -- see docs/PROJECT_SPEC.md §32). The only provider this module may actually import
// is its own deterministic in-process mock.
const FORBIDDEN_NETWORK_PATTERNS = [
  /\bimport\b[^;]*\bopenai\b/i,
  /\brequire\(["'][^"']*openai[^"']*["']\)/i,
  /\bimport\b[^;]*@anthropic-ai/i,
  /\brequire\(["'][^"']*@anthropic-ai[^"']*["']\)/i,
  /\bimport\b[^;]*\bdeepl\b/i,
  /\brequire\(["'][^"']*deepl[^"']*["']\)/i,
  /@google-cloud\/translate/i,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /require\(["']https?["']\)/,
  /from\s+["']https?["']/,
  /\baxios\b/i,
  /\bundici\b/i,
];

test("AC-SAFETY-01: no file in src/lib/ai-localization references a live-write-capable batches symbol", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const symbol of FORBIDDEN_WRITE_SYMBOLS) {
      if (content.includes(symbol)) {
        offenders.push(`${file}: references forbidden symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden live-write references:\n${offenders.join("\n")}`);
});

test("AC-COST-01: no file in src/lib/ai-localization depends on a real AI provider SDK or a network/HTTP client", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = stripComments(await readFile(file, "utf8"));
    for (const pattern of FORBIDDEN_NETWORK_PATTERNS) {
      if (pattern.test(content)) {
        offenders.push(`${file}: matches forbidden network/provider pattern ${pattern}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden network/provider dependencies:\n${offenders.join("\n")}`);
});

test("AC-PROVIDER-01 (structural): provider-registry.ts resolves only 'mock'", async () => {
  const content = await readFile(path.join(MODULE_ROOT, "provider-registry.ts"), "utf8");
  // Exactly one string-literal branch ("mock") should be resolvable; everything else
  // must fall through to the throw. This is a coarse but effective regression guard:
  // it fails if a second provider branch is added without this test being revisited.
  const literalBranches = content.match(/providerName === "[a-zA-Z0-9_-]+"/g) ?? [];
  assert.deepEqual(literalBranches, ['providerName === "mock"']);
});
