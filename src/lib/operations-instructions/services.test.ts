import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFsAdapter } from "./adapters/fs";
import { createOperationsInstructionsServices, isPathInsideOrEqual, MAX_FILE_BYTES } from "./services";
import { DomainError } from "./contracts";

async function withTempDirs(run: (dirs: { workspace: string; appData: string; outside: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "ops-instructions-test-"));
  try {
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(appData);
    await mkdir(outside);
    await run({ workspace, appData, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createServices(configuredPath: string | null, appDataDir: string) {
  const fsAdapter = createFsAdapter();
  return createOperationsInstructionsServices({
    getConfiguredPath: async () => configuredPath,
    appDataDir,
    ...fsAdapter,
  });
}

test("isPathInsideOrEqual: rejects a sibling directory with a shared prefix (no naive startsWith)", () => {
  assert.equal(isPathInsideOrEqual("/x/instr", "/x/instr-evil/secret"), false);
  assert.equal(isPathInsideOrEqual("/x/instr", "/x/instr"), true);
  assert.equal(isPathInsideOrEqual("/x/instr", "/x/instr/sub"), true);
  assert.equal(isPathInsideOrEqual("/x/instr/sub", "/x/instr"), false);
});

test("listOperationsFiles returns { configured: false } when no path is set, not an empty list", async () => {
  await withTempDirs(async ({ appData }) => {
    const services = createServices(null, appData);
    const result = await services.listOperationsFiles({});
    assert.deepEqual(result, { configured: false });
  });
});

test("getOperationsFile returns { configured: false } when no path is set", async () => {
  await withTempDirs(async ({ appData }) => {
    const services = createServices(null, appData);
    const result = await services.getOperationsFile({ path: "AGENTS.md" });
    assert.deepEqual(result, { configured: false });
  });
});

test("listOperationsFiles/getOperationsFile throw OPERATIONS_WORKSPACE_UNAVAILABLE when configured but the directory does not exist", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const missing = path.join(workspace, "does-not-exist");
    const services = createServices(missing, appData);

    await assert.rejects(
      () => services.listOperationsFiles({}),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
    );
    await assert.rejects(
      () => services.getOperationsFile({ path: "x.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
    );
  });
});

test("throws OPERATIONS_WORKSPACE_UNAVAILABLE when the configured path equals appDataDir", async () => {
  await withTempDirs(async ({ appData }) => {
    const services = createServices(appData, appData);
    await assert.rejects(
      () => services.listOperationsFiles({}),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
    );
  });
});

test("throws OPERATIONS_WORKSPACE_UNAVAILABLE when the configured path is a subdirectory of appDataDir", async () => {
  await withTempDirs(async ({ appData }) => {
    const sub = path.join(appData, "some-subdir");
    await mkdir(sub);
    const services = createServices(sub, appData);
    await assert.rejects(
      () => services.listOperationsFiles({}),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
    );
  });
});

test("throws OPERATIONS_WORKSPACE_UNAVAILABLE when the configured path is an ANCESTOR of appDataDir (would expose it underneath)", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    // appData is NOT actually under workspace on disk; simulate the ancestor relationship by
    // configuring appData's own parent directory as the workspace.
    const parentOfAppData = path.dirname(appData);
    const services = createServices(parentOfAppData, appData);
    await assert.rejects(
      () => services.listOperationsFiles({}),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
    );
    void workspace;
  });
});

test("listOperationsFiles returns real files, skips dotfiles, and filters by extension allowlist", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "AGENTS.md"), "# hi");
    await writeFile(path.join(workspace, ".env"), "SECRET=1");
    await writeFile(path.join(workspace, "notes.txt"), "notes");
    await writeFile(path.join(workspace, "binary.exe"), "not really binary but wrong extension");
    await mkdir(path.join(workspace, ".git"));
    await writeFile(path.join(workspace, ".git", "config"), "should never be listed");

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      const paths = result.files.map((f) => f.path).sort();
      assert.deepEqual(paths, ["AGENTS.md", "notes.txt"]);
      assert.equal(result.truncated, false);
    }
  });
});

test("listOperationsFiles descends into subdirectories and reports them as directory entries", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await mkdir(path.join(workspace, "channel-context"));
    await writeFile(path.join(workspace, "channel-context", "notes.md"), "notes");

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      const byPath = new Map(result.files.map((f) => [f.path, f]));
      assert.equal(byPath.get("channel-context")?.isDirectory, true);
      assert.equal(byPath.get("channel-context")?.sizeBytes, null);
      assert.equal(byPath.get("channel-context/notes.md")?.isDirectory, false);
    }
  });
});

test("getOperationsFile returns real file content and reports no truncation for a small file", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "AGENTS.md"), "# operations instructions");
    const services = createServices(workspace, appData);
    const result = await services.getOperationsFile({ path: "AGENTS.md" });
    assert.deepEqual(result, { configured: true, path: "AGENTS.md", content: "# operations instructions", truncated: false });
  });
});

test("getOperationsFile truncates a file larger than MAX_FILE_BYTES and reports truncated: true", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const big = "a".repeat(MAX_FILE_BYTES + 10);
    await writeFile(path.join(workspace, "big.md"), big);
    const services = createServices(workspace, appData);
    const result = await services.getOperationsFile({ path: "big.md" });
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.content.length, MAX_FILE_BYTES);
      assert.equal(result.truncated, true);
    }
  });
});

test("getOperationsFile rejects a relative path containing .. segments as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData, outside }) => {
    await writeFile(path.join(outside, "secret.md"), "secret");
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "../outside/secret.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects an absolute path as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData, outside }) => {
    const absoluteTarget = path.join(outside, "secret.md");
    await writeFile(absoluteTarget, "secret");
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: absoluteTarget }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a nonexistent file as OPERATIONS_FILE_NOT_AVAILABLE (same code as a traversal attempt, never distinguishable)", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "nonexistent.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a dotfile path as OPERATIONS_FILE_NOT_AVAILABLE even with an allowed extension", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, ".secret.md"), "hidden");
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: ".secret.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a disallowed extension as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "notes.exe"), "content");
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "notes.exe" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a directory path as OPERATIONS_FILE_NOT_AVAILABLE (get is for files only)", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await mkdir(path.join(workspace, "sub"));
    // "sub" has no extension, so it is already rejected by the extension allowlist before the
    // directory check would even run -- use a directory NAME that happens to end in an allowed
    // extension to actually exercise the isFile check.
    await mkdir(path.join(workspace, "weird.md"));
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "weird.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile follows a symlink that stays INSIDE the workspace and returns its content", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "real.md"), "real content");
    await symlink(path.join(workspace, "real.md"), path.join(workspace, "link.md"));
    const services = createServices(workspace, appData);
    const result = await services.getOperationsFile({ path: "link.md" });
    assert.deepEqual(result, { configured: true, path: "link.md", content: "real content", truncated: false });
  });
});

test("getOperationsFile rejects a symlink that escapes the workspace as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData, outside }) => {
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(path.join(outside, "secret.md"), path.join(workspace, "escape.md"));
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "escape.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a symlink that escapes INTO appDataDir as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(appData, "tokens.md"), "plaintext oauth tokens here");
    await symlink(path.join(appData, "tokens.md"), path.join(workspace, "leak.md"));
    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "leak.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("listOperationsFiles silently skips a symlinked entry that escapes the workspace, rather than erroring or leaking it", async () => {
  await withTempDirs(async ({ workspace, appData, outside }) => {
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(path.join(outside, "secret.md"), path.join(workspace, "escape.md"));
    await writeFile(path.join(workspace, "safe.md"), "safe");

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.deepEqual(
        result.files.map((f) => f.path),
        ["safe.md"]
      );
    }
  });
});

test("a workspace directory re-symlinked to point at appDataDir AFTER being configured is rejected at read time, not just at set time", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    // The "configured path" is a symlink the operator could repoint later -- simulate that by
    // configuring a symlink that already points at appDataDir (this module has no memory of what
    // the symlink target was when it was first configured; every read re-checks the CURRENT
    // real target, which is exactly what this test proves).
    const configuredSymlink = path.join(path.dirname(workspace), "workspace-symlink");
    await symlink(appData, configuredSymlink);
    try {
      const services = createServices(configuredSymlink, appData);
      await assert.rejects(
        () => services.listOperationsFiles({}),
        (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
      );
    } finally {
      await rm(configuredSymlink, { force: true });
    }
  });
});
