import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathValidationFsAdapter } from "./adapters/fs";
import { overlapsAppDataDir, validateWorkspacePath } from "./services";

// Expected results come from the set-time rules in docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-02
// (absolute, exists, is a directory, no overlap with app-data in either direction). They are not
// derived from this implementation. `operations-instructions/services.test.ts` still exercises
// the same functions through its re-export; this file covers the shared module directly.

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "local-path-validation-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("overlapsAppDataDir: equal, inside, and ancestor all overlap; a shared-prefix sibling does not", () => {
  assert.equal(overlapsAppDataDir("/a/app", "/a/app"), true);
  assert.equal(overlapsAppDataDir("/a/app/sub", "/a/app"), true);
  assert.equal(overlapsAppDataDir("/a", "/a/app"), true);
  assert.equal(overlapsAppDataDir("/a/app-other", "/a/app"), false);
});

test("validateWorkspacePath: accepts a real directory, rejects a file and a symlink into app-data", async () => {
  await withRoot(async (root) => {
    const appData = path.join(root, "app-data");
    const workspace = path.join(root, "workspace");
    await mkdir(appData);
    await mkdir(workspace);
    const file = path.join(root, "file.txt");
    await writeFile(file, "x");
    const link = path.join(root, "link-to-app-data");
    await symlink(appData, link);
    const deps = { appDataDir: appData, ...createPathValidationFsAdapter() };

    assert.deepEqual(await validateWorkspacePath(workspace, deps), { ok: true });
    assert.equal((await validateWorkspacePath(file, deps)).ok, false);
    assert.equal((await validateWorkspacePath(link, deps)).ok, false);
    assert.equal((await validateWorkspacePath("relative/dir", deps)).ok, false);
  });
});
