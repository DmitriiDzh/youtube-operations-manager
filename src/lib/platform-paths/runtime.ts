import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "./services";
import type { AppPaths } from "./contracts";

/**
 * Node's own built-in test runner sets this on every worker process it spawns (verified
 * empirically: `node --test` -> NODE_TEST_CONTEXT=child-v8, regardless of whether invoked via
 * `npm test` or directly). This is the single, shared signal every module that defaults to a
 * *real* app-data location (src/lib/db.ts, src/lib/cli-auth/storage.ts,
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
        homedir: path.join(os.tmpdir(), "youtube-ops-manager-test-singleton"),
      })
    : resolveAppPaths({
        platform: process.platform,
        env: process.env,
        homedir: os.homedir(),
      });

  return cachedAppPaths;
}
