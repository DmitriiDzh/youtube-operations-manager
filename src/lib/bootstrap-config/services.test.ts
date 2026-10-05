import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { withTempDir } from "@/test-support/temp-dir";
import { createBootstrapConfigStore } from "./services";

test("read() returns null when no config file exists yet", () =>
  withTempDir("bootstrap-config-test-", async (dir) => {
    const store = createBootstrapConfigStore(path.join(dir, "bootstrap-config.json"));
    assert.equal(await store.read(), null);
  }));

test("ensureExists() creates a config with a generated deviceId and null syncthingRootPath", () =>
  withTempDir("bootstrap-config-test-", async (dir) => {
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
  withTempDir("bootstrap-config-test-", async (dir) => {
    const store = createBootstrapConfigStore(path.join(dir, "bootstrap-config.json"));
    await store.ensureExists();
    const updated = await store.setSyncthingRootPath("D:\\Sync\\yt-ops");
    assert.equal(updated.syncthingRootPath, "D:\\Sync\\yt-ops");

    const reread = await store.read();
    assert.equal(reread?.syncthingRootPath, "D:\\Sync\\yt-ops");
  }));

test("read() rejects a malformed config file rather than silently ignoring it", () =>
  withTempDir("bootstrap-config-test-", async (dir) => {
    const configPath = path.join(dir, "bootstrap-config.json");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, "{ not valid json", "utf8");

    const store = createBootstrapConfigStore(configPath);
    await assert.rejects(() => store.read());
  }));

// Phase 11 review round 2: first-time creation must be exclusive. Concurrent first calls (here,
// separate store instances, as separate routes/processes would have) must all get the SAME
// deviceId -- the one actually on disk -- never one that a later write silently replaced.
test("ensureExists(): concurrent first-time calls all return the one deviceId that ends up on disk, leaving no temp files", () =>
  withTempDir("bootstrap-config-test-", async (dir) => {
    const configPath = path.join(dir, "bootstrap-config.json");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createBootstrapConfigStore(configPath).ensureExists())
    );
    const onDisk = await createBootstrapConfigStore(configPath).read();
    assert.ok(onDisk);
    for (const result of results) {
      assert.equal(result.deviceId, onDisk.deviceId);
    }
    assert.deepEqual(await readdir(dir), ["bootstrap-config.json"]);
  }));

// Phase 11 review round 3: a filesystem without hard-link support must not become a permanent
// failure -- ensureExists falls back to the previous rename-based creation.
test("ensureExists(): falls back to rename-based creation when hard links are unsupported", () =>
  withTempDir("bootstrap-config-test-", async (dir) => {
    const configPath = path.join(dir, "bootstrap-config.json");
    const noLinks = {
      link: async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    };
    const created = await createBootstrapConfigStore(configPath, noLinks).ensureExists();
    const onDisk = await createBootstrapConfigStore(configPath).read();
    assert.equal(onDisk?.deviceId, created.deviceId);
    assert.deepEqual(await readdir(dir), ["bootstrap-config.json"]);
  }));
