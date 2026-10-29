import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTempDir } from "./temp-dir";
import { DEFAULT_NEXT_CACHE_LIMIT_GB, nextCacheLimitBytes, trimNextCache } from "../../scripts/next-cache-trim.mjs";

// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866). Requirement: before a build, when .next/cache is larger than the limit
// (default 5 GB, overridable by the environment), .next/cache/turbopack is removed -- and nothing else -- and it is logged.

async function fakeNextFolder(root: string, turbopackBytes: number, otherBytes: number) {
  await mkdir(path.join(root, ".next", "cache", "turbopack", "deep"), { recursive: true });
  await mkdir(path.join(root, ".next", "cache", "images"), { recursive: true });
  await mkdir(path.join(root, ".next", "server"), { recursive: true });
  await writeFile(path.join(root, ".next", "cache", "turbopack", "deep", "blob"), Buffer.alloc(turbopackBytes));
  await writeFile(path.join(root, ".next", "cache", "images", "img"), Buffer.alloc(otherBytes));
  await writeFile(path.join(root, ".next", "server", "page.js"), "built");
  await writeFile(path.join(root, ".next-build-commit.txt"), "abc");
}

test("the limit: 5 GB by default, YTOM_NEXT_CACHE_LIMIT_GB when it is a positive number", () => {
  assert.equal(DEFAULT_NEXT_CACHE_LIMIT_GB, 5);
  assert.equal(nextCacheLimitBytes({}), 5_000_000_000);
  assert.equal(nextCacheLimitBytes({ YTOM_NEXT_CACHE_LIMIT_GB: "12" }), 12_000_000_000);
  assert.equal(nextCacheLimitBytes({ YTOM_NEXT_CACHE_LIMIT_GB: "0.5" }), 500_000_000);
  for (const bad of ["", "  ", "0", "-3", "abc", "Infinity"]) assert.equal(nextCacheLimitBytes({ YTOM_NEXT_CACHE_LIMIT_GB: bad }), 5_000_000_000, bad);
});

test("over the limit: only .next/cache/turbopack is removed, and it is logged", () =>
  withTempDir("next-cache-", async (root) => {
    await fakeNextFolder(root, 3000, 500);
    const lines: string[] = [];
    const result = await trimNextCache({ root, limitBytes: 2000, log: (line: string) => lines.push(line) });
    assert.deepEqual(result, { bytes: 3500, limitBytes: 2000, removed: true });
    assert.deepEqual(await readdir(path.join(root, ".next", "cache")), ["images"]);
    assert.equal(await readFile(path.join(root, ".next", "server", "page.js"), "utf8"), "built");
    assert.equal(await readFile(path.join(root, ".next-build-commit.txt"), "utf8"), "abc");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /removed \.next\/cache\/turbopack/);
  }));

test("at or under the limit nothing is removed (the limit counts the whole .next/cache)", () =>
  withTempDir("next-cache-", async (root) => {
    await fakeNextFolder(root, 1500, 500);
    const result = await trimNextCache({ root, limitBytes: 2000 });
    assert.equal(result.removed, false);
    assert.deepEqual((await readdir(path.join(root, ".next", "cache"))).sort(), ["images", "turbopack"]);
  }));

test("a check run measures only, even over the limit", () =>
  withTempDir("next-cache-", async (root) => {
    await fakeNextFolder(root, 3000, 0);
    const result = await trimNextCache({ root, limitBytes: 100, dryRun: true });
    assert.equal(result.removed, false);
    assert.deepEqual((await readdir(path.join(root, ".next", "cache"))).sort(), ["images", "turbopack"]);
  }));

test("no .next folder at all: nothing to do, no error", () =>
  withTempDir("next-cache-", async (root) => {
    const result = await trimNextCache({ root, limitBytes: 100 });
    assert.deepEqual(result, { bytes: 0, limitBytes: 100, removed: false });
    assert.deepEqual(await readdir(root), []);
  }));
