import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "./contracts";
import { createKeyFile, type KeyFileAccess } from "./key-file";
import { createKeyFileFsAccess, mediaKeyFilePath } from "./adapters/key-file-fs";

// AC-P14-21 (docs/roadmap/plans/PHASE_14_PLAN.md §2.9/§4): the key is created by the app on first
// use, in the app-data directory, mode 0600; a read never creates it; a malformed file fails closed.

function memoryAccess(initial: string | null = null) {
  let content = initial;
  const writes: string[] = [];
  const access: KeyFileAccess = {
    async read() {
      return content;
    },
    async write(next) {
      content = JSON.stringify(next);
      writes.push(content);
    },
    randomBytes: (size) => Buffer.alloc(size, 9),
  };
  return { access, writes, get: () => content };
}

test("readKey returns null without a file and never writes one", async () => {
  const { access, writes } = memoryAccess();
  assert.equal(await createKeyFile(access).readKey(), null);
  assert.deepEqual(writes, []);
});

test("readOrCreateKey creates a 32-byte key once and returns the same key afterwards", async () => {
  const { access, writes, get } = memoryAccess();
  const keyFile = createKeyFile(access);
  const first = await keyFile.readOrCreateKey();
  const second = await keyFile.readOrCreateKey();
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(get() ?? ""), { version: 1, key: Buffer.alloc(32, 9).toString("base64") });
});

test("a malformed key file fails closed with encryption_key_not_configured, not a plaintext fallback", async () => {
  for (const bad of ["not json", JSON.stringify({ version: 2, key: "x" }), JSON.stringify({ version: 1, key: Buffer.alloc(16).toString("base64") })]) {
    const keyFile = createKeyFile(memoryAccess(bad).access);
    await assert.rejects(keyFile.readKey(), (e: unknown) => isDomainError(e) && e.code === "encryption_key_not_configured");
    await assert.rejects(keyFile.readOrCreateKey(), (e: unknown) => isDomainError(e) && e.code === "encryption_key_not_configured");
  }
});

test("the real file adapter writes media-generation.key under the app-data dir with mode 0600", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-key-test-"));
  try {
    const filePath = mediaKeyFilePath(dir);
    assert.equal(path.basename(filePath), "media-generation.key");
    const keyFile = createKeyFile(createKeyFileFsAccess(filePath));
    assert.equal(await keyFile.readKey(), null);
    const key = await keyFile.readOrCreateKey();
    assert.equal(key.length, 32);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(parsed.version, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await keyFile.readKey(), key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review 11: the key-file methods work detached (no `this`)", async () => {
  let content: string | null = null;
  const access: KeyFileAccess = { read: async () => content, write: async (c) => void (content = JSON.stringify(c)), randomBytes: (n) => Buffer.alloc(n, 7) };
  const { readOrCreateKey, readKey } = createKeyFile(access);
  assert.equal(await readKey(), null);
  const created = await readOrCreateKey();
  assert.equal(created.length, 32);
  assert.deepEqual(await readKey(), created);
});
