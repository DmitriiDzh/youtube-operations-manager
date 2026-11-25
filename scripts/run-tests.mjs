// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): `npm test` runs the suite with every temporary folder under ONE
// folder of its own, `<temp base>/ytm-test-run-<pid>-<start ms>`, and removes that folder when the run ends -- one full
// run used to leave about 300 MB behind in the system temp folder (8.5 GB after ~25 runs). The test runner starts a process
// per test file; each inherits TMPDIR/TMP/TEMP (os.tmpdir() reads TMPDIR on macOS/Linux, TEMP/TMP on Windows), so every
// mkdtemp(os.tmpdir()) of every test lands inside the run's folder without editing the tests. At the start, run folders
// left by a run that was killed (older than 2 h, process gone) are removed too.
//
// Owner, Telegram 4903 (2026-11-25): on the owner's Mac the temp base is the external T9 disk when it is mounted
// (`<T9>/YouTube/00 Tools/_ytm-test-tmp/`), so test runs stop wearing the internal SSD; `YTM_TEST_TMP=<folder>` picks
// another folder, `YTM_TEST_TMP=system` the system temp folder. Everywhere else it is the system temp folder (testRunBaseDir).
//
//   npm test                                       the whole suite (src/**/*.test.ts)
//   npm test -- src/lib/x.test.ts                  only these files or patterns
//   npm test -- --test-name-pattern=word           options for node's test runner (`--name=value` or `--name value`)
//
// Plain Node, no shell: it works the same on Windows.
import { spawn } from "node:child_process";
import { mkdirSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeFor, refusedRunnerArgs, removeWithRetry, sweepStaleTestRunRoots, testRunBaseDir, testRunEnv, testRunnerArgs, testRunRootName, tsxCacheFolderName } from "./test-temp-root.mjs";

const refused = refusedRunnerArgs(process.argv.slice(2));
if (refused) {
  console.error(`[run-tests] ${refused}`);
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemTmp = os.tmpdir();
const isDir = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const isOtherVolumeDir = (dir) => {
  try {
    const stats = statSync(dir);
    return stats.isDirectory() && stats.dev !== statSync(systemTmp).dev;
  } catch {
    return false;
  }
};
let { base, source } = testRunBaseDir({ env: process.env, platform: process.platform, systemTmp, isOtherVolumeDir });
if (source !== "system") {
  try {
    // The T9 folder is made only inside an existing `00 Tools` (never `recursive` above it); a chosen folder as given.
    mkdirSync(base, { recursive: source === "env" });
  } catch (error) {
    if (error?.code !== "EEXIST" || !isDir(base)) {
      console.warn(`[run-tests] cannot use ${base} (${error?.code ?? error}); using the system temp folder`);
      base = systemTmp;
      source = "system";
    }
  }
}
if (source !== "system") console.log(`[run-tests] temporary files: ${base}`);
const root = path.join(base, testRunRootName(process.pid, Date.now()));

for (const dir of new Set([base, systemTmp])) {
  const swept = await sweepStaleTestRunRoots(dir, { now: Date.now(), ownRoot: root });
  if (swept.length > 0) console.log(`[run-tests] removed ${swept.length} left-behind test run folder(s) from ${dir}`);
}
mkdirSync(root, { recursive: true });
// tsx's compile cache stays where it always was, in the system temp folder (a link inside the run folder; removing the run
// folder removes only the link).
try {
  const tsxCache = path.join(systemTmp, tsxCacheFolderName());
  mkdirSync(tsxCache, { recursive: true });
  symlinkSync(tsxCache, path.join(root, tsxCacheFolderName()), process.platform === "win32" ? "junction" : "dir");
} catch {
  // No link: tsx compiles into the run folder, which is removed with it (slower, still clean).
}

const child = spawn(process.execPath, testRunnerArgs(process.argv.slice(2)), {
  cwd: repoRoot,
  env: testRunEnv(process.env, root),
  stdio: "inherit",
});

// Ctrl+C / a stop / a closed terminal reaches the test runner; this process waits for it to end and then cleans up.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}

// The T9 folder goes once no run uses it (another run's folder inside keeps it: removing a non-empty folder fails).
function removeT9BaseIfEmpty() {
  if (source !== "t9") return;
  try {
    rmdirSync(base);
  } catch {
    // another run is using it, or it is already gone
  }
}

child.on("exit", async (code, signal) => {
  const removed = await removeWithRetry(root);
  if (!removed) console.warn(`[run-tests] could not remove ${root}; the next run removes it once it is 2 h old`);
  removeT9BaseIfEmpty();
  process.exit(exitCodeFor(code, signal));
});
child.on("error", async (error) => {
  console.error(`[run-tests] could not start the test runner: ${error.message}`);
  await removeWithRetry(root);
  removeT9BaseIfEmpty();
  process.exit(1);
});
