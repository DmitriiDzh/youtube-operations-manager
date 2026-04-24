import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createActiveAuthStorage } from "./storage";

test("active auth storage writes atomically and reads context", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "auth-storage-"));
  const storage = createActiveAuthStorage(baseDir);

  const written = await storage.write({ activeUserId: "user-1" });
  assert.equal(written.activeUserId, "user-1");

  const raw = JSON.parse(
    await readFile(path.join(baseDir, "data", "auth-context.json"), "utf8")
  ) as { activeUserId: string; version: number };
  assert.equal(raw.activeUserId, "user-1");
  assert.equal(raw.version, 1);

  const readBack = await storage.read();
  assert.equal(readBack?.activeUserId, "user-1");
});

test("active auth storage creates secure permissions when platform supports it", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "auth-storage-perms-"));
  const storage = createActiveAuthStorage(baseDir);

  await storage.write({ activeUserId: "user-1" });
  const contextFilePath = path.join(baseDir, "data", "auth-context.json");
  const info = await stat(contextFilePath);

  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test("active auth storage clear removes context", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "auth-storage-clear-"));
  const storage = createActiveAuthStorage(baseDir);

  await storage.write({ activeUserId: "user-1" });
  await storage.clear();

  const context = await storage.read();
  assert.equal(context, null);
});
