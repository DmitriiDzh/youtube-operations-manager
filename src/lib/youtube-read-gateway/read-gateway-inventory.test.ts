// ---------------------------------------------------------------------------
// The mechanical enforcement of the owner's single-funnel-for-reads instruction (2026-09-22,
// Telegram): "Все запросы на получения данных должны идти через него и никак иначе." The
// read-side counterpart to `src/lib/youtube-write-gateway/gateway-inventory.test.ts`
// (`docs/decisions/0007-youtube-read-gateway.md`).
//
// This is an import-level check, not a call-shape regex: any *production* file (never a
// `.test.ts`, which legitimately imports `youtube_v3`/`youtubeAnalytics_v2` as a TYPE to build
// fakes/mocks, never a real client) that imports a RUNTIME (non-`type`-only) value from
// `googleapis` at all is either this gateway, `src/lib/youtube-write-gateway/`, or the OAuth
// client factory in `auth.ts` -- confirmed to be the complete, small, stable current set by
// inspection (2026-09-22). This is verb-agnostic and notation-agnostic in a way a call-shape
// regex (like the write gateway's own `WRITE_CALL_PATTERN`) cannot be: it would also catch a
// future `const v = youtube.videos; v.list(...)` or bracket-notation
// `youtube["videos"]["list"](...)`, not only a literal `.resource.verb(` dot-call. A
// `import type { youtube_v3 } from "googleapis"` line is exempt everywhere -- TypeScript erases
// it at compile time, so it can never construct a client or call a method at runtime.
//
// Deliberately protects BOTH reads and writes at once (there is exactly one way for any code in
// this repository to reach a real Google API client at all: `auth.ts`'s
// `createGoogleOAuthClient`, consumed only by the two gateways) -- this single check is what
// makes "every read goes through this gateway" actually true, not merely documented.
//
// Widened 2026-09-26 (independent test-suite audit): the import-level check used to look only
// for a static `from "googleapis"` line, missing a side-effect `import "googleapis"`, a dynamic
// `import("googleapis")`, or a CommonJS `require("googleapis")` -- the exact class of gap already
// found and fixed the same day in `src/lib/shared-xlsx/usage-inventory.test.ts`. Both tests here
// now catch all four forms, and scanning was widened from `src/` alone to `src/` + `scripts/` to
// match that same fix's precedent. Known, accepted limitation (unchanged, shared with every
// regex-based inventory test in this repository): a determined obfuscation (string
// concatenation, `eval`) is not caught.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const READ_GATEWAY_DIR = THIS_DIR;
const WRITE_GATEWAY_DIR = path.join(REPO_ROOT, "src", "lib", "youtube-write-gateway");
const SCAN_ROOTS = ["src", "scripts"];

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
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function listAllScannedFiles(): Promise<string[]> {
  const lists = await Promise.all(SCAN_ROOTS.map((root) => listTsFilesRecursively(path.join(REPO_ROOT, root))));
  return lists.flat();
}

// The single narrow exception: the OAuth client factory itself, which must import `googleapis`
// to construct `google.auth.OAuth2` -- it never calls any resource/method, only builds the
// client object both gateways then use. (`youtube-analytics.ts` no longer needs its own entry
// here -- folded into this gateway as `analytics-api.ts`, 2026-09-22, so it's already excluded
// by the `isInsideDir(file, READ_GATEWAY_DIR)` check below.)
const GOOGLEAPIS_IMPORT_ALLOWLIST = new Set([path.join("src", "lib", "auth.ts")]);

function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// A static `from "googleapis"` line is exempt when the whole import is `import type` (erased at
// compile time, never a runtime import) -- side-effect/dynamic/require forms have no such
// type-only variant, so they are never exempt.
function hasRuntimeGoogleapisImport(content: string): boolean {
  const hasRuntimeFromImport = content
    .split("\n")
    .some((line) => /from\s*["']googleapis["']/.test(line) && !/^\s*import\s+type\b/.test(line));
  if (hasRuntimeFromImport) return true;

  return (
    /^\s*import\s*["']googleapis["']/m.test(content) ||
    /import\s*\(\s*["']googleapis["']\s*\)/.test(content) ||
    /require\s*\(\s*["']googleapis["']\s*\)/.test(content)
  );
}

test("read-gateway inventory: no production file outside youtube-read-gateway/, youtube-write-gateway/, or auth.ts has a runtime import from googleapis", async () => {
  const allFiles = await listAllScannedFiles();
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (isInsideDir(file, READ_GATEWAY_DIR)) continue;
    if (isInsideDir(file, WRITE_GATEWAY_DIR)) continue;

    const relative = path.relative(REPO_ROOT, file);
    if (GOOGLEAPIS_IMPORT_ALLOWLIST.has(relative)) continue;

    const content = await readFile(file, "utf8");
    if (hasRuntimeGoogleapisImport(content)) {
      offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following production files have a runtime (non-type-only) import from "googleapis" ` +
      `(static, side-effect, dynamic, or require), which makes a read or write call possible ` +
      `without ever going through src/lib/youtube-read-gateway or src/lib/youtube-write-gateway: ` +
      `${offenders.join(", ")}`
  );
});

// Every production file that DOES need a YouTube-family read must go through this gateway's own
// barrel (`index.ts`), not reach into a specific child file (`data-api.ts`, and later
// `analytics-api.ts`) directly -- keeps the umbrella genuinely the one thing callers need to know
// about, and means a future re-shuffling of which child owns which function never touches a
// caller's import path.
const CHILD_MODULE_SPECIFIER = String.raw`@/lib/youtube-read-gateway/[a-zA-Z0-9_-]+`;
const DIRECT_CHILD_IMPORT_PATTERNS = [
  new RegExp(String.raw`from\s*["']${CHILD_MODULE_SPECIFIER}["']`),
  new RegExp(String.raw`^\s*import\s*["']${CHILD_MODULE_SPECIFIER}["']`, "m"),
  new RegExp(String.raw`import\s*\(\s*["']${CHILD_MODULE_SPECIFIER}["']\s*\)`),
  new RegExp(String.raw`require\s*\(\s*["']${CHILD_MODULE_SPECIFIER}["']\s*\)`),
];

test("read-gateway inventory: no production file outside this gateway imports a child module directly (data-api.ts, etc.) instead of the barrel", async () => {
  const allFiles = await listAllScannedFiles();
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (isInsideDir(file, READ_GATEWAY_DIR)) continue;

    const content = await readFile(file, "utf8");
    if (DIRECT_CHILD_IMPORT_PATTERNS.some((pattern) => pattern.test(content))) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following files import a youtube-read-gateway child module directly instead of the ` +
      `barrel (@/lib/youtube-read-gateway): ${offenders.join(", ")}`
  );
});

// Independent test-suite audit (2026-09-26): proves the widened patterns above actually catch
// every form they claim to, using the same verification style already established in
// shared-xlsx/usage-inventory.test.ts.
test("read-gateway inventory: the widened patterns catch static/side-effect/dynamic/require forms for both checks", () => {
  const googleapisShouldMatch = [
    `import { google } from "googleapis";`,
    `import "googleapis";`,
    `const g = await import("googleapis");`,
    `const g = require("googleapis");`,
  ];
  const googleapisShouldNotMatch = [
    `import type { youtube_v3 } from "googleapis";`,
    `// mentions googleapis only in a comment`,
    `const label = "googleapis";`,
  ];
  for (const sample of googleapisShouldMatch) {
    assert.ok(hasRuntimeGoogleapisImport(sample), `Expected to catch: ${sample}`);
  }
  for (const sample of googleapisShouldNotMatch) {
    assert.ok(!hasRuntimeGoogleapisImport(sample), `Expected NOT to catch: ${sample}`);
  }

  const childShouldMatch = [
    `import { queryChannelAnalyticsReport } from "@/lib/youtube-read-gateway/analytics-api";`,
    `import "@/lib/youtube-read-gateway/data-api";`,
    `const m = await import("@/lib/youtube-read-gateway/data-api");`,
    `const m = require("@/lib/youtube-read-gateway/data-api");`,
  ];
  const childShouldNotMatch = [`import { X } from "@/lib/youtube-read-gateway";`];
  for (const sample of childShouldMatch) {
    assert.ok(
      DIRECT_CHILD_IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected to catch: ${sample}`
    );
  }
  for (const sample of childShouldNotMatch) {
    assert.ok(
      !DIRECT_CHILD_IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected NOT to catch: ${sample}`
    );
  }
});
