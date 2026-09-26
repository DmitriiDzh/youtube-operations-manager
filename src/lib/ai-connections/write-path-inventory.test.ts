// ---------------------------------------------------------------------------
// AC-CONN-14 (docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md): structural
// inventory mirroring src/lib/ai-localization/write-path-inventory.test.ts's pattern.
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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

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

test("AC-CONN-14a: no file in src/lib/ai-connections references a live-write-capable batches symbol", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const symbol of FORBIDDEN_WRITE_SYMBOLS) {
      if (content.includes(symbol)) offenders.push(`${file}: references forbidden symbol "${symbol}"`);
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden live-write references:\n${offenders.join("\n")}`);
});

// AC-CONN-14b: the only place a bare global `fetch` may be called in production
// wiring is index.ts's `productionFetch`, which is itself only ever passed as an
// injected dependency -- every other file must receive its HTTP client as a
// parameter, never reference the global directly. This is what makes "zero real
// network calls in the automated test suite" a structural property: a test can only
// reach a real host if it deliberately constructs and passes in a real fetch
// implementation, which no test in this repository does.
test("AC-CONN-14b: no file other than index.ts references the bare global fetch identifier", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    if (path.basename(file) === "index.ts") continue;
    const content = stripComments(await readFile(file, "utf8"));
    if (/\bfetch\s*\(/.test(content)) offenders.push(file);
  }

  assert.deepEqual(offenders, [], `Found bare fetch() references outside index.ts:\n${offenders.join("\n")}`);
});

// Builds the 4 import-form patterns (static `from`, side-effect `import "..."`, dynamic
// `import(...)`, `require(...)`) for a module-specifier regex fragment, matching an actual
// import/require SPECIFIER string, never merely a word containing the package name -- this
// deliberately does NOT flag this module's own "openai-compatible" adapter filename/identifiers,
// which describe a PROTOCOL this code implements itself, not a dependency on OpenAI's own SDK
// package. Widened 2026-09-26 (independent test-suite audit): the previous version only matched
// a static `from "openai"`/`require("openai")` with the specifier EXACTLY "openai" -- verified
// empirically that `from "openai/resources"` (any subpath import, the normal way to reach SDK
// helpers), a side-effect `import "openai"`, and a dynamic `await import("openai")` all passed
// through undetected. The `(?:/[^"']*)?` suffix below additionally covers subpath imports.
function buildSdkImportPatterns(packageSpecifier: string): RegExp[] {
  const moduleSpecifier = `${packageSpecifier}(?:/[^"']*)?`;
  return [
    new RegExp(String.raw`from\s*["']${moduleSpecifier}["']`, "i"),
    new RegExp(String.raw`^\s*import\s*["']${moduleSpecifier}["']`, "im"),
    new RegExp(String.raw`import\s*\(\s*["']${moduleSpecifier}["']\s*\)`, "i"),
    new RegExp(String.raw`require\s*\(\s*["']${moduleSpecifier}["']\s*\)`, "i"),
  ];
}

const SDK_IMPORT_PATTERNS = [
  ...buildSdkImportPatterns("openai"),
  ...buildSdkImportPatterns("@anthropic-ai"),
  /\baxios\b/i,
  /\bundici\b/i,
];

test("AC-CONN-14c: no real AI provider SDK is imported anywhere in this module", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = stripComments(await readFile(file, "utf8"));
    for (const pattern of SDK_IMPORT_PATTERNS) {
      if (pattern.test(content)) offenders.push(`${file}: matches ${pattern}`);
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden SDK dependencies:\n${offenders.join("\n")}`);
});

test("AC-CONN-14c patterns: the widened openai/@anthropic-ai detection actually catches subpath/side-effect/dynamic imports", () => {
  const shouldMatch = [
    `import OpenAI from "openai";`,
    `import { X } from "openai/resources";`,
    `import "openai";`,
    `const m = await import("openai");`,
    `const m = require("openai/resources");`,
    `import Anthropic from "@anthropic-ai/sdk";`,
    `const m = await import("@anthropic-ai/sdk");`,
  ];
  const shouldNotMatch = [
    `import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible";`,
    `// this module implements an openai-compatible protocol adapter, not the openai SDK`,
    `const label = "openai-compatible";`,
  ];

  for (const sample of shouldMatch) {
    assert.ok(
      SDK_IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected to catch: ${sample}`
    );
  }
  for (const sample of shouldNotMatch) {
    assert.ok(
      !SDK_IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected NOT to catch: ${sample}`
    );
  }
});
