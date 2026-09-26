// ---------------------------------------------------------------------------
// The mechanical enforcement of the owner's single-funnel instruction (2026-09-21, Telegram):
// "Никакие будущие модули не имеют права записывать / изменять / отправлять данные на
// YouTube в обход этого модуля." This is checked by grep, not by convention, so a future
// change that adds a direct write call anywhere else fails the test suite immediately.
//
// Scope note: this test only enforces the PHYSICAL call site (which file is allowed to
// invoke a mutating `youtube_v3.Youtube` method) -- it deliberately does not forbid
// `YOUTUBE_WRITE_SCOPE` outside this module, because OAuth scope resolution legitimately
// happens one layer up, in each domain module's `services.ts` (see
// `docs/DEVELOPMENT_PLAYBOOK.md` §6.4 point 4/§6.5) -- a service must be able to ask for
// write scope before it even knows whether the eventual call succeeds, which is a distinct
// concern from "which file makes the network call". Folding scope resolution into this
// module as well would be a much larger architectural change than what was asked for, and is
// not what this instruction requires.
//
// The stronger, import-level check ("no production file outside an approved gateway/auth.ts
// has a runtime import from googleapis at all") used to live in this file too, but as of the
// read-side gateway (2026-09-22, `docs/decisions/0007-youtube-read-gateway.md`) it protects a
// joint invariant -- read AND write entry points both -- so it now lives in
// `src/lib/youtube-read-gateway/read-gateway-inventory.test.ts` instead of being duplicated or
// left arbitrarily owned by only one side.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const GATEWAY_DIR = THIS_DIR;
// Matches read-gateway-inventory.test.ts's own SCAN_ROOTS (independent test-suite audit,
// 2026-09-26) -- a build/one-off script under scripts/ is just as capable of a direct mutating
// call as anything under src/, so both inventory tests should scan the same root set.
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

// Every YouTube Data API v3 resource with at least one documented mutating method, and every
// mutating verb across them (developers.google.com/youtube/v3/docs) -- deliberately broader
// than just the handful of methods this repository happens to call today, so a future module
// adding e.g. `thumbnails.set` or `channels.update` trips this test too, not only the seven
// call shapes already known about.
// `captions.download` is deliberately excluded from the mutating-verb list below: despite the
// name, it is a read (fetches caption track bytes), not a mutation -- see
// `src/lib/video-metadata/adapters/transcript-provider.ts`, a legitimate, pre-existing
// read-only caller this test must not flag. `captions.insert/update/delete` (real mutations)
// are still caught -- only the one verb `download` is excluded, not the whole `captions` resource.
// Widened 2026-09-26 (independent test-suite audit) after checking every resource's actual
// method set in the installed `googleapis` package's own type definitions
// (node_modules/googleapis/build/src/apis/youtube/v3.d.ts): `abuseReports.insert`,
// `playlistImages.insert/update/delete`, and `thirdPartyLinks.insert/update/delete` were real
// mutating methods on resources this pattern didn't list at all; `liveBroadcasts.insertCuepoint`
// was a real mutating verb the old verb alternation (only the literal `insert`) didn't match even
// though `liveBroadcasts` itself was already listed. The `tests` resource's own `insert` method is
// deliberately NOT added here despite being real and documented -- "tests" is common enough as an
// ordinary property/variable name elsewhere in this codebase that including it would create a
// real false-positive risk (e.g. `someRecord.tests.insert(...)` in unrelated code) for a resource
// this app will realistically never call; if that ever changes, add it explicitly rather than
// widening the resource list further.
const WRITE_CALL_PATTERN =
  /\.(videos|playlists|playlistItems|playlistImages|captions|thumbnails|channels|channelSections|channelBanners|comments|commentThreads|subscriptions|liveBroadcasts|liveStreams|liveChatBans|liveChatMessages|liveChatModerators|members|watermarks|abuseReports|thirdPartyLinks)\.(insert|insertCuepoint|update|delete|set|unset|rate|reportAbuse|bind|transition|control|markAsSpam|setModerationStatus)\s*\(/;

test("youtube-write-gateway inventory: no file outside this module calls a mutating youtube_v3 method directly", async () => {
  const allFiles = await listAllScannedFiles();
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (path.resolve(path.dirname(file)) === path.resolve(GATEWAY_DIR)) continue;

    const content = await readFile(file, "utf8");
    const match = content.match(WRITE_CALL_PATTERN);
    if (match) {
      offenders.push(`${path.relative(REPO_ROOT, file)} (matched "${match[0]}")`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following files call a mutating YouTube API method directly, bypassing ` +
      `src/lib/youtube-write-gateway -- the single funnel for every outbound write ` +
      `(AGENTS.md §G): ${offenders.join(", ")}`
  );
});

// The gateway's real, network-hitting write primitives (excludes `assertLiveWritesAuthorized`
// itself and the pure field-whitelist helpers `pickWritable*Fields`, which have no barrier to
// check). Every caller of any of these must call `assertLiveWritesAuthorized` itself, since the
// primitives deliberately do not call it themselves (see index.ts's own module doc comment).
const WRITE_PRIMITIVE_NAMES = [
  "applyVideoMetadataUpdate",
  "applyVideoDetailsUpdate",
  "createPlaylistForAuthenticated",
  "updatePlaylistForAuthenticated",
  "deletePlaylistForAuthenticated",
  "addVideoToPlaylistForAuthenticated",
  "deletePlaylistItemById",
];

test("youtube-write-gateway inventory: every file that imports a real write primitive also calls assertLiveWritesAuthorized", async () => {
  // Discovered, not hardcoded (independent test-suite audit, 2026-09-26): the old version of
  // this test named only 3 files by hand and silently never checked a 4th, real, already-existing
  // caller (`src/lib/batches/adapters/write-executor.youtube.ts`, which does call the barrier
  // correctly today -- this fix makes that a proven fact instead of an unverified one). Scanning
  // for actual importers means a future 5th caller can't slip through the same way.
  const allFiles = await listAllScannedFiles();
  const callers: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (path.resolve(path.dirname(file)) === path.resolve(GATEWAY_DIR)) continue;

    const content = await readFile(file, "utf8");
    const importsAnyWritePrimitive = WRITE_PRIMITIVE_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(content));
    if (importsAnyWritePrimitive) {
      callers.push(file);
    }
  }

  assert.ok(callers.length > 0, "Expected at least one real caller of a write-gateway primitive -- found none, check the scan itself");

  // A plain substring check would be satisfied by a comment merely mentioning the function's
  // name (verified this is a real, not hypothetical, gap this fix closes) -- require an actual
  // call shape instead. Note: this does NOT verify the call happens *before* the write primitive
  // call in execution order -- that would require real call-graph analysis across function
  // boundaries (a caller may correctly call the barrier in one function and the write primitive
  // in a different function it invokes, e.g. `write-executor.youtube.ts`'s `attemptWrite` ->
  // `performYoutubeWrite` split, which is correct but would not appear "before" in raw file-text
  // order) -- out of scope for a regex-based inventory test; this only proves the call exists.
  const callPattern = /assertLiveWritesAuthorized\s*\(/;
  for (const file of callers) {
    const content = await readFile(file, "utf8");
    assert.ok(
      callPattern.test(content),
      `${path.relative(REPO_ROOT, file)} imports a write-gateway primitive but never actually calls ` +
        `assertLiveWritesAuthorized() (a mention in a comment or string doesn't count)`
    );
  }
});
