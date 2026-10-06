import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "../contracts";
import { createTemplateRegistryReader } from "./template-registry-fs";

// BL-132 (plan §2.3): only index.json and <id>.v<n>.json directly in the folder are read; a symlink out of the folder,
// a non-regular file or a name outside the pattern is never read; a missing folder/index is "unavailable".

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-registry-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reads the index and a listed template file; a file not there yet reads as null", () =>
  withDir(async (dir) => {
    await writeFile(path.join(dir, "index.json"), '{"x":1}');
    await writeFile(path.join(dir, "flux.v1.json"), "{}");
    const snapshot = await createTemplateRegistryReader({ resolveDir: async () => dir }).read();
    assert.equal(snapshot.indexText, '{"x":1}');
    assert.equal(await snapshot.readTemplateFile("flux.v1.json"), "{}");
    assert.equal(await snapshot.readTemplateFile("flux.v2.json"), null);
  }));

test("a symlink pointing outside the folder, a directory, or a name outside the pattern is never read", () =>
  withDir(async (dir) => {
    const outside = await mkdtemp(path.join(tmpdir(), "ytm-outside-"));
    try {
      await writeFile(path.join(outside, "secret.json"), "SECRET");
      await writeFile(path.join(dir, "index.json"), "{}");
      await symlink(path.join(outside, "secret.json"), path.join(dir, "evil.v1.json"));
      await mkdir(path.join(dir, "dir.v1.json"));
      await writeFile(path.join(dir, "notes.json"), "{}");
      const snapshot = await createTemplateRegistryReader({ resolveDir: async () => dir }).read();
      assert.equal(await snapshot.readTemplateFile("evil.v1.json"), null);
      assert.equal(await snapshot.readTemplateFile("dir.v1.json"), null);
      assert.equal(await snapshot.readTemplateFile("notes.json"), null);
      assert.equal(await snapshot.readTemplateFile("../secret.v1.json"), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }));

test("no configured path, a missing folder, or a folder without index.json is media_template_registry_unavailable", () =>
  withDir(async (dir) => {
    const notConfigured = createTemplateRegistryReader({
      resolveDir: async () => {
        throw new Error("LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
      },
    });
    await assert.rejects(notConfigured.read(), (e: unknown) => isDomainError(e) && e.code === "media_template_registry_unavailable");
    await assert.rejects(createTemplateRegistryReader({ resolveDir: async () => path.join(dir, "gone") }).read(), (e: unknown) => isDomainError(e) && e.code === "media_template_registry_unavailable");
    await assert.rejects(createTemplateRegistryReader({ resolveDir: async () => dir }).read(), (e: unknown) => isDomainError(e) && e.code === "media_template_registry_unavailable" && /index\.json/.test(e.message));
  }));
