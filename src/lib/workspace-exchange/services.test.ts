import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { createExchangeFs } from "./adapters/fs";
import { resolveFromYtmDir, resolveFromYtmJobFile, resolveSentToYtmFile } from "./services";

// Behaviour fixed by ADR 0019 (amendment 2026-10-04): the folder is exactly <workspace>/99 Data Exchange/From YTM,
// created when missing, refused when a symlink or a file sits at any of the three paths; nothing else is touched.

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-exchange-"));
  try {
    await run(path.join(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const args = (workspace: string) => ({
  workspace,
  fs: createExchangeFs(),
  validateWorkspacePath: async () => ({ ok: true as const }),
  isPathInsideOrEqual,
  unavailable: (reason: string) => new Error(`unavailable: ${reason}`),
});

test("creates 99 Data Exchange/From YTM (and the empty Sent to YTM) and returns the real path; a second call changes nothing", () =>
  withWorkspace(async (workspace) => {
    const dir = await resolveFromYtmDir(args(workspace));
    assert.equal(dir, path.join(await realpath(workspace), "99 Data Exchange", "From YTM"));
    assert.deepEqual((await readdir(path.join(workspace, "99 Data Exchange"))).sort(), ["From YTM", "Sent to YTM"]);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await resolveFromYtmDir(args(workspace)), dir);
    assert.deepEqual(await readdir(workspace), ["99 Data Exchange"]);
  }));

test("a From YTM symlink pointing outside the workspace is refused with the caller's error; a file in its place is refused too", () =>
  withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    try {
      const exchange = path.join(workspace, "99 Data Exchange");
      await createExchangeFs().mkdir(exchange);
      await symlink(outside, path.join(exchange, "From YTM"));
      await assert.rejects(resolveFromYtmDir(args(workspace)), /unavailable: .*not a plain folder/);
      assert.equal((await lstat(path.join(exchange, "From YTM"))).isSymbolicLink(), true);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await rm(path.join(workspace, "99 Data Exchange"), { recursive: true, force: true });
    await writeFile(path.join(workspace, "99 Data Exchange"), "not a folder");
    await assert.rejects(resolveFromYtmDir(args(workspace)), /unavailable: 99 Data Exchange is not a plain folder/);
  }));

test("a failed workspace validation is refused before anything is created", () =>
  withWorkspace(async (workspace) => {
    await assert.rejects(resolveFromYtmDir({ ...args(workspace), validateWorkspacePath: async () => ({ ok: false, reason: "path is inside the app-data directory" }) }), /unavailable: path is inside/);
    assert.deepEqual(await readdir(workspace), []);
  }));

// -- BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.4, AC-FM-11): job input files from `99 Data Exchange/Sent to YTM/` ----------
// Real temp folders: a path that escapes the folder (`..`, absolute, a symlink out), a non-file, or a missing folder is
// refused; a file inside (also in a subfolder) resolves to its real path and size. Nothing is created or deleted.

test("AC-FM-11: resolveSentToYtmFile resolves a file (or a file in a subfolder) inside Sent to YTM to its real path and size", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const { createExchangeFs } = await import("./adapters/fs");
  const { isPathInsideOrEqual } = await import("@/lib/local-path-validation");
  const ws = await mkdtemp(pathMod.join(tmpdir(), "ytm-ws-"));
  try {
    const sent = pathMod.join(ws, "99 Data Exchange", "Sent to YTM");
    await mkdir(pathMod.join(sent, "refs"), { recursive: true });
    await writeFile(pathMod.join(sent, "refs", "frame 1.png"), "12345");
    const resolved = await resolveSentToYtmFile({
      workspace: ws,
      relativePath: "refs/frame 1.png",
      fs: createExchangeFs(),
      validateWorkspacePath: async () => ({ ok: true }),
      isPathInsideOrEqual,
      unavailable: (reason) => new Error(reason),
    });
    const { realpath } = await import("node:fs/promises");
    assert.equal(resolved.path, await realpath(pathMod.join(sent, "refs", "frame 1.png")));
    assert.equal(resolved.bytes, 5);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("AC-FM-11: a path escaping Sent to YTM (.., absolute, backslash, a symlink out), a folder, a missing file or a missing Sent to YTM folder is refused", async () => {
  const { mkdtemp, mkdir, writeFile, rm, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const { createExchangeFs } = await import("./adapters/fs");
  const { isPathInsideOrEqual } = await import("@/lib/local-path-validation");
  const ws = await mkdtemp(pathMod.join(tmpdir(), "ytm-ws-"));
  const outside = await mkdtemp(pathMod.join(tmpdir(), "ytm-out-"));
  try {
    const resolve = (relativePath: string, workspace = ws) =>
      resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable: (reason) => new Error(reason) });
    await assert.rejects(resolve("x.png"), /does not exist/, "no Sent to YTM folder yet");
    const sent = pathMod.join(ws, "99 Data Exchange", "Sent to YTM");
    await mkdir(pathMod.join(sent, "dir"), { recursive: true });
    await writeFile(pathMod.join(ws, "secret.txt"), "s");
    await writeFile(pathMod.join(outside, "elsewhere.png"), "e");
    await symlink(pathMod.join(outside, "elsewhere.png"), pathMod.join(sent, "link.png"));
    for (const bad of ["../../secret.txt", "/etc/passwd", "C:/x.png", "refs\\\\x.png", "./x.png", "a//b.png", ""]) {
      await assert.rejects(resolve(bad), /not a path relative/, bad);
    }
    await assert.rejects(resolve("link.png"), /resolves outside/);
    await assert.rejects(resolve("dir"), /not a regular file/);
    await assert.rejects(resolve("missing.png"), /is not in/);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// BL-143 (ADR 0029, AC-GP-14): a job output the owner listens to is served only from that job's own folder under From YTM.
test("BL-143 resolveFromYtmJobFile: only a regular file inside From YTM/<subdir>/<jobId>/; a symlink out, another job's file or a missing file is refused", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-job-file-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-job-outside-")));
  try {
    const workspace = path.join(root, "ws");
    const jobDir = path.join(workspace, "99 Data Exchange", "From YTM", "media", "job-1");
    const otherDir = path.join(workspace, "99 Data Exchange", "From YTM", "media", "job-2");
    await mkdir(jobDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await writeFile(path.join(jobDir, "track.mp3"), "0123456789");
    await writeFile(path.join(otherDir, "other.mp3"), "x");
    await writeFile(path.join(outside, "secret.txt"), "s");
    await symlink(path.join(outside, "secret.txt"), path.join(jobDir, "link.mp3"));
    const resolve = (jobId: string, filePath: string) =>
      resolveFromYtmJobFile({ workspace, subdir: "media", jobId, filePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable: (reason) => new Error(reason) });
    assert.deepEqual(await resolve("job-1", path.join(jobDir, "track.mp3")), { path: path.join(jobDir, "track.mp3"), bytes: 10 });
    await assert.rejects(resolve("job-1", path.join(jobDir, "link.mp3")), /outside the job's output folder/);
    await assert.rejects(resolve("job-1", path.join(otherDir, "other.mp3")), /outside the job's output folder/);
    await assert.rejects(resolve("job-1", path.join(jobDir, "missing.mp3")), /not on this device/);
    await assert.rejects(resolve("job-1", jobDir), /outside the job's output folder/, "the folder itself");
    await assert.rejects(resolve("../job-2", path.join(otherDir, "other.mp3")), /not a job folder/);
    await assert.rejects(resolve("job-9", path.join(jobDir, "track.mp3")), /not in the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
