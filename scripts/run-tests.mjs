// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): `npm test` runs the suite with every temporary folder under ONE
// folder of its own, `<system temp>/ytm-test-run-<pid>-<start ms>`, and removes that folder when the run ends -- one full
// run used to leave about 300 MB behind in the system temp folder (8.5 GB after ~25 runs). The test runner starts a process
// per test file; each inherits TMPDIR/TMP/TEMP (os.tmpdir() reads TMPDIR on macOS/Linux, TEMP/TMP on Windows), so every
// mkdtemp(os.tmpdir()) of every test lands inside the run's folder without editing the tests. At the start, run folders
// left by a run that was killed (older than 2 h, process gone) are removed too.
//
//   npm test                                       the whole suite (src/**/*.test.ts)
//   npm test -- src/lib/x.test.ts                  only these files or patterns
//   npm test -- --test-name-pattern=word           options for node's test runner (`--name=value` or `--name value`)
//
// Plain Node, no shell: it works the same on Windows.
import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeFor, removeWithRetry, sweepStaleTestRunRoots, testRunEnv, testRunnerArgs, testRunRootName, tsxCacheFolderName } from "./test-temp-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = os.tmpdir();
const root = path.join(base, testRunRootName(process.pid, Date.now()));

const swept = await sweepStaleTestRunRoots(base, { now: Date.now(), ownRoot: root });
if (swept.length > 0) console.log(`[run-tests] removed ${swept.length} left-behind test run folder(s) from ${base}`);
mkdirSync(root, { recursive: true });
// tsx's compile cache stays where it always was (a link inside the run folder; removing the run folder removes only the link).
try {
  const tsxCache = path.join(base, tsxCacheFolderName());
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

child.on("exit", async (code, signal) => {
  const removed = await removeWithRetry(root);
  if (!removed) console.warn(`[run-tests] could not remove ${root}; the next run removes it once it is 2 h old`);
  process.exit(exitCodeFor(code, signal));
});
child.on("error", async (error) => {
  console.error(`[run-tests] could not start the test runner: ${error.message}`);
  await removeWithRetry(root);
  process.exit(1);
});
