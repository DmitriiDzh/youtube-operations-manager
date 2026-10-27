import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathValidationFsAdapter } from "@/lib/local-path-validation/adapters/fs";
import { isPathInsideOrEqual, validateWorkspacePath } from "@/lib/local-path-validation/services";
import { createExchangeFs } from "@/lib/workspace-exchange";
import { createMusicLibraryFiles } from "./adapters/files";
import { createMusicLibraryService } from "./services";

// BL-229 part A, AC-ML-06/07/08 on the REAL workspace-exchange and path-validation rules, in a temporary folder (never the T9
// volume): the snapshot read where it is; nothing there = no file; a link to a file outside the workspace is refused.

const SNAPSHOT = {
  format: 1,
  generatedAt: "2026-10-27T10:00:00.000Z",
  genres: [{ id: "rural-japan-control", title: "Sounds of Rural Japan", status: "active", batches: 13, tracks: 390, seconds: 70_200, neverUsedSeconds: 36_000, daysLeft: 41 }],
  batches: [],
  tracksWithoutGenre: 0,
};

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "music-library-")));
  const appData = path.join(root, "app-data");
  const wsA = path.join(root, "Rural Japan");
  const wsB = path.join(root, "Tropico");
  for (const dir of [appData, wsA, wsB]) await mkdir(dir, { recursive: true });
  const musicDir = (ws: string) => path.join(ws, "99 Data Exchange", "Sent to YTM", "music");
  const files = createMusicLibraryFiles({
    fs: createExchangeFs(),
    validateWorkspacePath: (candidate) => validateWorkspacePath(candidate, { appDataDir: appData, ...createPathValidationFsAdapter() }),
    isPathInsideOrEqual,
    readFile: (filePath) => readFile(filePath, "utf8"),
  });
  return { root, wsA, wsB, musicDir, files, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("the snapshot inside the workspace is read; nothing there is 'missing'; an unreachable workspace is its own state", async () => {
  const { root, wsA, musicDir, files, cleanup } = await setup();
  try {
    assert.deepEqual(await files.read(wsA), { kind: "missing" });
    await mkdir(musicDir(wsA), { recursive: true });
    assert.deepEqual(await files.read(wsA), { kind: "missing" });
    await writeFile(path.join(musicDir(wsA), "library.json"), JSON.stringify(SNAPSHOT));
    const read = await files.read(wsA);
    assert.equal(read.kind, "text");
    assert.deepEqual(JSON.parse((read as { text: string }).text), SNAPSHOT);
    assert.equal((await files.read(path.join(root, "unplugged"))).kind, "workspace_unavailable");
  } finally {
    await cleanup();
  }
});

test("AC-ML-08: library.json that is a symlink to a file outside the workspace is refused, and the service shows it unreadable", async () => {
  const { root, wsA, musicDir, files, cleanup } = await setup();
  try {
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify(SNAPSHOT));
    await mkdir(musicDir(wsA), { recursive: true });
    await symlink(outside, path.join(musicDir(wsA), "library.json"));
    const read = await files.read(wsA);
    assert.equal(read.kind, "refused");
    assert.match((read as { reason: string }).reason, /resolves outside the channel workspace/);

    const service = createMusicLibraryService({ getWorkspace: async () => ({ configured: true, path: wsA }), files, now: () => new Date("2026-10-27T12:00:00.000Z") });
    const result = await service.read("UC_A");
    assert.equal(result.status, "unreadable");
  } finally {
    await cleanup();
  }
});

test("a symlinked 'music' folder pointing outside the workspace is refused too; a dangling link is not 'no file'", async () => {
  const { root, wsA, files, cleanup } = await setup();
  try {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "library.json"), JSON.stringify(SNAPSHOT));
    await mkdir(path.join(wsA, "99 Data Exchange", "Sent to YTM"), { recursive: true });
    await symlink(elsewhere, path.join(wsA, "99 Data Exchange", "Sent to YTM", "music"));
    assert.equal((await files.read(wsA)).kind, "refused");

    await rm(path.join(wsA, "99 Data Exchange", "Sent to YTM", "music"));
    await mkdir(path.join(wsA, "99 Data Exchange", "Sent to YTM", "music"));
    await symlink(path.join(root, "nothing.json"), path.join(wsA, "99 Data Exchange", "Sent to YTM", "music", "library.json"));
    assert.equal((await files.read(wsA)).kind, "refused");
  } finally {
    await cleanup();
  }
});

test("a file larger than the limit is refused unread", async () => {
  const { root, wsA, musicDir, cleanup } = await setup();
  try {
    await mkdir(musicDir(wsA), { recursive: true });
    await writeFile(path.join(musicDir(wsA), "library.json"), JSON.stringify(SNAPSHOT));
    let reads = 0;
    const small = createMusicLibraryFiles({
      fs: createExchangeFs(),
      validateWorkspacePath: (candidate) => validateWorkspacePath(candidate, { appDataDir: path.join(root, "app-data"), ...createPathValidationFsAdapter() }),
      isPathInsideOrEqual,
      readFile: async () => (reads++, ""),
      maxBytes: 10,
    });
    const read = await small.read(wsA);
    assert.equal(read.kind, "refused");
    assert.equal(reads, 0);
  } finally {
    await cleanup();
  }
});

test("AC-ML-07: channel A's library comes from A's workspace even when B's holds another snapshot", async () => {
  const { wsA, wsB, musicDir, files, cleanup } = await setup();
  try {
    await mkdir(musicDir(wsA), { recursive: true });
    await mkdir(musicDir(wsB), { recursive: true });
    await writeFile(path.join(musicDir(wsA), "library.json"), JSON.stringify(SNAPSHOT));
    await writeFile(path.join(musicDir(wsB), "library.json"), JSON.stringify({ ...SNAPSHOT, tracksWithoutGenre: 7 }));
    const workspaces: Record<string, string> = { UC_A: wsA, UC_B: wsB };
    const service = createMusicLibraryService({
      getWorkspace: async (channelId) => (workspaces[channelId] ? { configured: true, path: workspaces[channelId] } : { configured: false }),
      files,
      now: () => new Date("2026-10-27T12:00:00.000Z"),
    });
    const a = await service.read("UC_A");
    assert.equal(a.status, "ok");
    assert.equal((a as { view: { withoutGenre: unknown } }).view.withoutGenre, null);
    const b = await service.read("UC_B");
    assert.equal((b as { view: { withoutGenre: { tracks: number } } }).view.withoutGenre.tracks, 7);
    assert.deepEqual(await service.read("UC_C"), { status: "no_workspace" });
  } finally {
    await cleanup();
  }
});
