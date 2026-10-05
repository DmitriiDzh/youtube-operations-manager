import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { createExchangeFs } from "./adapters/fs";
import { resolveFromYtmDir } from "./services";

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
