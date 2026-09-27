import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "./services";
import type { AppPaths } from "./contracts";

/**
 * Node's own built-in test runner sets this on every worker process it spawns (verified
 * empirically: `node --test` -> NODE_TEST_CONTEXT=child-v8, regardless of whether invoked via
 * `npm test` or directly). This is the single, shared signal every module that defaults to a
 * *real* app-data location (src/lib/db.ts, src/lib/cli-auth/adapters/active-auth-storage.ts,
 * src/lib/backup/adapters/filesystem-store.ts) uses to avoid ever touching the operator's real
 * app-data directory or real legacy `data/` folder merely because `npm test` imported them --
 * per docs/DEVELOPMENT_PLAYBOOK.md §6.11. One implementation, not one per call site
 * (AGENTS.md §D).
 */
export function isRunningUnderTestRunner(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

let cachedAppPaths: AppPaths | null = null;

/**
 * The production (or, under the test runner, an isolated-temp-redirected) app-data paths
 * singleton. Every module defaulting to "the real app-data location" should call this instead
 * of calling `resolveAppPaths` directly with `process.*` -- so the test-runner redirect only
 * has to be implemented once.
 */
export function getProductionAppPaths(): AppPaths {
  if (cachedAppPaths) return cachedAppPaths;

  if (isRunningUnderTestRunner()) {
    const testHomedir = path.join(os.tmpdir(), `youtube-ops-manager-test-singleton-${process.pid}`);
    // Found by independent review, 2026-09-27: PIDs are reused by the OS over a long enough
    // session (this repository's own test/build invocations alone left 36,947 stale singleton
    // directories in the system temp dir at one point), so a new process can silently inherit a
    // PREVIOUS, unrelated process's leftover database at this exact PID-keyed path -- including
    // real rows (e.g. an enabled agent-connection) that made an entirely different test file fail
    // with a confusing, seemingly-unrelated error. Wiping this directory before first use makes
    // "this PID's test database" actually mean "a pristine database," regardless of PID reuse.
    // Safe unconditionally: this branch only ever runs under the test runner, and the directory
    // itself is nothing but this kind of disposable, single-run temp state.
    fs.rmSync(testHomedir, { recursive: true, force: true });
    cachedAppPaths = resolveAppPaths({
      platform: process.platform,
      env: {},
      // Node's test runner isolates each *file* in its own subprocess by default
      // (test-isolation=process), each with a distinct PID -- folding it into this path
      // gives every test file its own pristine singleton database for free. Without this,
      // every test file across an `npm test` run shared one fixed, persistent temp path,
      // so state written by one file's tests (e.g. an operation-lock row, a batch_ledger_row)
      // could leak into a completely unrelated file's tests within the same run -- exactly
      // the kind of cross-test pollution this redirect exists to prevent in the first place.
      homedir: testHomedir,
    });
  } else {
    cachedAppPaths = resolveAppPaths({
      platform: process.platform,
      env: process.env,
      homedir: os.homedir(),
    });
  }

  return cachedAppPaths;
}
