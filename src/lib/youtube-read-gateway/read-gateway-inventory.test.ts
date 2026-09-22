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

// The single narrow exception: the OAuth client factory itself, which must import `googleapis`
// to construct `google.auth.OAuth2` -- it never calls any resource/method, only builds the
// client object both gateways then use.
const GOOGLEAPIS_IMPORT_ALLOWLIST = new Set([path.join("src", "lib", "auth.ts")]);

function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

test("read-gateway inventory: no production file outside youtube-read-gateway/, youtube-write-gateway/, or auth.ts has a runtime import from googleapis", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (isInsideDir(file, READ_GATEWAY_DIR)) continue;
    if (isInsideDir(file, WRITE_GATEWAY_DIR)) continue;

    const relative = path.relative(REPO_ROOT, file);
    if (GOOGLEAPIS_IMPORT_ALLOWLIST.has(relative)) continue;

    const content = await readFile(file, "utf8");
    const runtimeImport = content
      .split("\n")
      .some((line) => /from\s+["']googleapis["']/.test(line) && !/^\s*import\s+type\b/.test(line));
    if (runtimeImport) {
      offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following production files have a runtime (non-type-only) import from "googleapis", ` +
      `which makes a read or write call possible without ever going through ` +
      `src/lib/youtube-read-gateway or src/lib/youtube-write-gateway, even in a shape a ` +
      `call-site regex cannot see (bracket notation, an aliased reference, etc.): ${offenders.join(", ")}`
  );
});

// Every production file that DOES need a YouTube-family read must go through this gateway's own
// barrel (`index.ts`), not reach into a specific child file (`data-api.ts`, and later
// `analytics-api.ts`) directly -- keeps the umbrella genuinely the one thing callers need to know
// about, and means a future re-shuffling of which child owns which function never touches a
// caller's import path.
test("read-gateway inventory: no production file outside this gateway imports a child module directly (data-api.ts, etc.) instead of the barrel", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const offenders: string[] = [];
  const directChildImportPattern = /from\s+["']@\/lib\/youtube-read-gateway\/[a-zA-Z0-9_-]+["']/;

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (isInsideDir(file, READ_GATEWAY_DIR)) continue;

    const content = await readFile(file, "utf8");
    if (directChildImportPattern.test(content)) {
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
