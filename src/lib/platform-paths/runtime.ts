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

  cachedAppPaths = isRunningUnderTestRunner()
    ? resolveAppPaths({
        platform: process.platform,
        env: {},
        // Node's test runner isolates each *file* in its own subprocess by default
        // (test-isolation=process), each with a distinct PID -- folding it into this path
        // gives every test file its own pristine singleton database for free. Without this,
        // every test file across an `npm test` run shared one fixed, persistent temp path,
        // so state written by one file's tests (e.g. an operation-lock row, a batch_ledger_row)
        // could leak into a completely unrelated file's tests within the same run -- exactly
        // the kind of cross-test pollution this redirect exists to prevent in the first place.
        homedir: path.join(os.tmpdir(), `youtube-ops-manager-test-singleton-${process.pid}`),
      })
    : resolveAppPaths({
        platform: process.platform,
        env: process.env,
        homedir: os.homedir(),
      });

  return cachedAppPaths;
}
