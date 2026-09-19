import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBootstrapConfigStore } from "./services";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bootstrap-config-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("read() returns null when no config file exists yet", () =>
  withTempDir(async (dir) => {
    const store = createBootstrapConfigStore(path.join(dir, "bootstrap-config.json"));
    assert.equal(await store.read(), null);
  }));

test("ensureExists() creates a config with a generated deviceId and null syncthingRootPath", () =>
  withTempDir(async (dir) => {
    const store = createBootstrapConfigStore(path.join(dir, "bootstrap-config.json"));
    const config = await store.ensureExists();
    assert.equal(config.version, 1);
    assert.ok(config.deviceId.length > 0);
    assert.equal(config.syncthingRootPath, null);

    // idempotent: calling again returns the same deviceId, doesn't regenerate
    const again = await store.ensureExists();
    assert.equal(again.deviceId, config.deviceId);
  }));

test("setSyncthingRootPath() persists and is readable back", () =>
  withTempDir(async (dir) => {
    const store = createBootstrapConfigStore(path.join(dir, "bootstrap-config.json"));
    await store.ensureExists();
    const updated = await store.setSyncthingRootPath("D:\\Sync\\yt-ops");
    assert.equal(updated.syncthingRootPath, "D:\\Sync\\yt-ops");

    const reread = await store.read();
    assert.equal(reread?.syncthingRootPath, "D:\\Sync\\yt-ops");
  }));

test("read() rejects a malformed config file rather than silently ignoring it", () =>
  withTempDir(async (dir) => {
    const configPath = path.join(dir, "bootstrap-config.json");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, "{ not valid json", "utf8");

    const store = createBootstrapConfigStore(configPath);
    await assert.rejects(() => store.read());
  }));
