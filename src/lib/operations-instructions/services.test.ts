import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, unlink, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFsAdapter } from "./adapters/fs";
import { createOperationsInstructionsServices, isPathInsideOrEqual, validateWorkspacePath, MAX_FILE_BYTES } from "./services";
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

// Independent review found that a symlink whose VISIBLE name has an allowed extension could
// point at a dotfile/disallowed-extension REAL target still inside the workspace, bypassing the
// dotfile-exclusion guarantee (the check only ever looked at the visible name, never the resolved
// target). Both directions -- listing and direct get -- must exclude/reject based on the
// RESOLVED target, not just the requested name.
test("listOperationsFiles excludes a symlink whose visible name is allowed but whose real target is a dotfile", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, ".secret-config"), "sensitive-config-content");
    await symlink(path.join(workspace, ".secret-config"), path.join(workspace, "notes.md"));
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

test("getOperationsFile rejects a symlink whose visible name is allowed but whose real target is a dotfile, as OPERATIONS_FILE_NOT_AVAILABLE", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, ".secret-config"), "sensitive-config-content");
    await symlink(path.join(workspace, ".secret-config"), path.join(workspace, "notes.md"));

    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "notes.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

test("getOperationsFile rejects a symlink whose visible name is allowed but whose real target has a disallowed extension", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "script.exe"), "binary-ish content");
    await symlink(path.join(workspace, "script.exe"), path.join(workspace, "notes.md"));

    const services = createServices(workspace, appData);
    await assert.rejects(
      () => services.getOperationsFile({ path: "notes.md" }),
      (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_FILE_NOT_AVAILABLE"
    );
  });
});

// Round 2 of independent review found that `listOperationsFiles` and `getOperationsFile` had
// become asymmetric after round 1's dotfile fix: a symlink with a DISALLOWED visible extension
// (e.g. "link.exe") pointing at an ALLOWED-extension real target would be LISTED (only the
// resolved name was checked) but then always REJECTED by getOperationsFile (which checks both the
// visible and resolved name) -- not a security bug (nothing leaked, it failed closed), but a
// confusing contract where a path returned by list always 404s on get. Fixed by requiring both
// checks in `walk()` too, matching `getOperationsFile`'s own symmetry.
test("listOperationsFiles excludes a symlink whose visible name has a disallowed extension even when its real target's extension is allowed", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    await writeFile(path.join(workspace, "actual.md"), "real content");
    await symlink(path.join(workspace, "actual.md"), path.join(workspace, "link.exe"));

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.deepEqual(
        result.files.map((f) => f.path),
        ["actual.md"]
      );
    }
  });
});

test("a workspace directory re-symlinked to point at appDataDir AFTER being configured is rejected at read time, not just at set time", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    // Proves the DYNAMIC property this module's threat model relies on: this module has no
    // memory of what the symlink target was when it was first configured/validated -- every read
    // re-checks the CURRENT real target. An earlier version of this test only ever pointed the
    // symlink at appDataDir and never established a genuinely successful read first, so it could
    // not actually distinguish "re-pointed to something unsafe" from "was never safe to begin
    // with" -- fixed here to do both halves for real: succeed while safe, then fail once
    // re-pointed, using the SAME `services` instance (which re-resolves the path on every call,
    // never caching it) throughout.
    await writeFile(path.join(workspace, "AGENTS.md"), "# safe content");
    const configuredSymlink = path.join(path.dirname(workspace), "workspace-symlink");
    await symlink(workspace, configuredSymlink);
    try {
      const services = createServices(configuredSymlink, appData);

      const beforeRepoint = await services.listOperationsFiles({});
      assert.equal(beforeRepoint.configured, true);
      if (beforeRepoint.configured) {
        assert.deepEqual(beforeRepoint.files.map((f) => f.path), ["AGENTS.md"]);
      }

      await unlink(configuredSymlink);
      await symlink(appData, configuredSymlink);

      await assert.rejects(
        () => services.listOperationsFiles({}),
        (error: unknown) => error instanceof DomainError && error.code === "OPERATIONS_WORKSPACE_UNAVAILABLE"
      );
    } finally {
      await rm(configuredSymlink, { force: true });
    }
  });
});

// Independent review found `validateWorkspacePath` (the set-time gate `POST /api/settings`
// calls) had zero direct test coverage of its own -- only its read-time sibling
// (`resolveRealConfiguredBase`, exercised indirectly via `listOperationsFiles`/`getOperationsFile`
// above) was tested. Both share the same `overlapsAppDataDir`/`isPathInsideOrEqual` logic, but the
// operator-facing entry point's own absolute/exists/is-directory checks deserve their own direct
// tests rather than being asserted only by a manual browser check.
test("validateWorkspacePath rejects a relative path", async () => {
  const fsAdapter = createFsAdapter();
  const result = await validateWorkspacePath("relative/path", { appDataDir: "/irrelevant", ...fsAdapter });
  assert.deepEqual(result, { ok: false, reason: "path must be absolute" });
});

test("validateWorkspacePath rejects a nonexistent path", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const fsAdapter = createFsAdapter();
    const result = await validateWorkspacePath(path.join(workspace, "does-not-exist"), { appDataDir: appData, ...fsAdapter });
    assert.deepEqual(result, { ok: false, reason: "path does not exist or is not accessible" });
  });
});

test("validateWorkspacePath rejects a path that is a file, not a directory", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const filePath = path.join(workspace, "AGENTS.md");
    await writeFile(filePath, "# hi");
    const fsAdapter = createFsAdapter();
    const result = await validateWorkspacePath(filePath, { appDataDir: appData, ...fsAdapter });
    assert.deepEqual(result, { ok: false, reason: "path is not a directory" });
  });
});

test("validateWorkspacePath rejects a path equal to appDataDir", async () => {
  await withTempDirs(async ({ appData }) => {
    const fsAdapter = createFsAdapter();
    const result = await validateWorkspacePath(appData, { appDataDir: appData, ...fsAdapter });
    assert.deepEqual(result, { ok: false, reason: "path overlaps this application's own app-data directory" });
  });
});

test("validateWorkspacePath rejects a path that is an ancestor of appDataDir", async () => {
  await withTempDirs(async ({ appData }) => {
    const fsAdapter = createFsAdapter();
    const result = await validateWorkspacePath(path.dirname(appData), { appDataDir: appData, ...fsAdapter });
    assert.deepEqual(result, { ok: false, reason: "path overlaps this application's own app-data directory" });
  });
});

test("validateWorkspacePath accepts a genuinely valid, non-overlapping absolute directory", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    const fsAdapter = createFsAdapter();
    const result = await validateWorkspacePath(workspace, { appDataDir: appData, ...fsAdapter });
    assert.deepEqual(result, { ok: true });
  });
});

// MAX_FILES/MAX_DEPTH caps -- the commit message claimed these were tested alongside
// MAX_FILE_BYTES truncation, but only the byte cap actually had a test. Import the real
// constants via a small re-exercise: MAX_DEPTH is 6, MAX_FILES is 300 in the current
// implementation (see services.ts) -- these tests exercise both without hard-coding a second
// copy of those numbers, by creating one more entry than the smaller, cheaper-to-test cap allows.
test("listOperationsFiles reports truncated: true once MAX_DEPTH is exceeded", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    // MAX_DEPTH is 6 (0-indexed from the workspace root) -- nest 8 levels deep to guarantee the
    // cap is hit regardless of the exact off-by-one convention.
    let currentDir = workspace;
    for (let i = 0; i < 8; i += 1) {
      currentDir = path.join(currentDir, `level-${i}`);
      await mkdir(currentDir);
      await writeFile(path.join(currentDir, "notes.md"), "content");
    }

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.truncated, true);
    }
  });
});

test("listOperationsFiles reports truncated: true once MAX_FILES is exceeded", async () => {
  await withTempDirs(async ({ workspace, appData }) => {
    // MAX_FILES is 300 -- create 305 flat files to guarantee the cap is hit.
    for (let i = 0; i < 305; i += 1) {
      await writeFile(path.join(workspace, `note-${String(i).padStart(4, "0")}.md`), "content");
    }

    const services = createServices(workspace, appData);
    const result = await services.listOperationsFiles({});
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.truncated, true);
      assert.ok(result.files.length <= 300);
    }
  });
});
