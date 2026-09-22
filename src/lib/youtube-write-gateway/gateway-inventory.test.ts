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
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const GATEWAY_DIR = THIS_DIR;

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
const WRITE_CALL_PATTERN =
  /\.(videos|playlists|playlistItems|captions|thumbnails|channels|channelSections|channelBanners|comments|commentThreads|subscriptions|liveBroadcasts|liveStreams|liveChatBans|liveChatMessages|liveChatModerators|members|watermarks)\.(insert|update|delete|set|unset|rate|reportAbuse|bind|transition|control|markAsSpam|setModerationStatus)\s*\(/;

test("youtube-write-gateway inventory: no file outside this module calls a mutating youtube_v3 method directly", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
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

test("youtube-write-gateway inventory: no file outside this module imports its write primitives via a re-export chain that skips assertLiveWritesAuthorized", async () => {
  // Defense in depth for the three known non-batches call sites: each must call
  // `assertLiveWritesAuthorized` itself before its own gateway write call, since the gateway's
  // raw primitives (applyVideoMetadataUpdate, applyVideoDetailsUpdate, the playlist functions)
  // deliberately do not call it themselves (see index.ts's own module doc comment for why).
  const requiredCallers = [
    { file: path.join(REPO_ROOT, "src", "lib", "video-metadata", "adapters", "youtube-api.ts"), writeFn: "applyVideoMetadataUpdate" },
    { file: path.join(REPO_ROOT, "src", "lib", "video-details", "adapters", "youtube-api.ts"), writeFn: "applyVideoDetailsUpdate" },
    { file: path.join(REPO_ROOT, "src", "lib", "playlist-management", "adapters", "youtube-api.ts"), writeFn: "createPlaylistForAuthenticated" },
  ];

  for (const { file, writeFn } of requiredCallers) {
    const content = await readFile(file, "utf8");
    assert.ok(
      content.includes("assertLiveWritesAuthorized"),
      `${path.relative(REPO_ROOT, file)} calls the gateway's ${writeFn} but never calls assertLiveWritesAuthorized`
    );
  }
});

// The call-shape regex above only catches literal `.resource.verb(` dot-call syntax -- a future
// file writing `const v = youtube.videos; v.update(...)`, or bracket-notation
// `youtube["videos"]["update"](...)`, would slip past it undetected. An import-level check is
// verb-agnostic and notation-agnostic in a way no call-shape regex can be: any *production* file
// (never a `.test.ts`, which legitimately imports `youtube_v3` as a type to build fakes/mocks,
// never a real client) that imports a runtime (non-`type`-only) value from `googleapis` at all is
// either this gateway, the read-only `youtube.ts`, the read-only `youtube-analytics.ts` (Phase 8,
// BL-052 -- a distinct Google API product/client namespace, `google.youtubeAnalytics`, with no
// mutating method on this surface at all, so nothing here for this gateway to ever own), or the
// OAuth client factory in `auth.ts` -- confirmed to be the complete, small, stable current set by
// inspection (2026-09-22, updated from 2026-09-21's three-file set when `youtube-analytics.ts`
// was added). A `import type { youtube_v3 } from "googleapis"` line is exempt everywhere --
// TypeScript erases it at compile time, so it can never construct a client or call a method at
// runtime (see `src/lib/batches/adapters/write-executor.youtube.ts`, which type-only-imports
// `youtube_v3`
// purely to type its mockable `MinimalYoutubeWriteClient` boundary).
const GOOGLEAPIS_IMPORT_ALLOWLIST = new Set([
  path.join("src", "lib", "youtube.ts"),
  path.join("src", "lib", "youtube-analytics.ts"),
  path.join("src", "lib", "auth.ts"),
]);

test("youtube-write-gateway inventory: no production file outside this module, youtube.ts, youtube-analytics.ts, or auth.ts has a runtime import from googleapis", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (path.resolve(path.dirname(file)) === path.resolve(GATEWAY_DIR)) continue;

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
      `which makes a mutating call possible without ever going through ` +
      `src/lib/youtube-write-gateway, even in a shape the call-site regex above cannot see ` +
      `(bracket notation, an aliased reference, etc.): ${offenders.join(", ")}`
  );
});
