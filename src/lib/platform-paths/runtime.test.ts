// ---------------------------------------------------------------------------
// Found by independent review, 2026-09-27: `getProductionAppPaths()`'s test-runner singleton path
// is keyed only by `process.pid`, with no cleanup -- over a long session (or CI history), the OS
// reuses PIDs, so a new process can silently inherit a PREVIOUS, unrelated process's leftover
// database at that exact path, including real rows that make an entirely different test fail with
// a confusing, seemingly-unrelated error. This test proves the fix: the directory is wiped before
// first use, every time, regardless of what was left there by an earlier process that happened to
// share this PID.
//
// Relies on `node --test`'s own file-level process isolation (this module's own doc comment) to
// guarantee this is the FIRST call to `getProductionAppPaths()` in this process -- its internal
// cache is otherwise permanent for the life of the process and cannot be reset from a test.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("getProductionAppPaths wipes a stale leftover directory at its PID-keyed singleton path before first use", async () => {
  const expectedDir = path.join(os.tmpdir(), `youtube-ops-manager-test-singleton-${process.pid}`);
  const staleMarkerFile = path.join(expectedDir, "leftover-from-a-previous-process-that-shared-this-pid.txt");

  fs.mkdirSync(expectedDir, { recursive: true });
  fs.writeFileSync(staleMarkerFile, "if this file still exists after getProductionAppPaths(), the wipe did not happen");
  assert.ok(fs.existsSync(staleMarkerFile), "test setup itself must have created the stale file");

  const { getProductionAppPaths } = await import("./runtime");
  const paths = getProductionAppPaths();

  // `appDataDir` nests platform-specific subdirectories under this homedir (e.g.
  // `<expectedDir>/Library/Application Support/YouTubeOperationsManager` on macOS) --
  // `startsWith` confirms this is really the same PID-keyed root the stale file was seeded under.
  assert.ok(
    paths.appDataDir.startsWith(expectedDir),
    "sanity check -- this is really the same path the stale file was seeded under"
  );
  assert.ok(!fs.existsSync(staleMarkerFile), "the stale leftover file must be gone -- a reused PID must never inherit a previous process's state");
});
