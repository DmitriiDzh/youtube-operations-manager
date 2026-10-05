import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Independent test-suite audit (2026-09-26): this exact mkdtemp/finally-rm helper was
// independently duplicated in 9 test files across the repository (snapshot, bootstrap-config,
// atomic-json-file, db-backup, device-handoff, and 4 sync-gateway adapter/integration tests).
// Consolidated here -- test-only infrastructure, never imported by production code (see
// `docs/DEVELOPMENT_PLAYBOOK.md` §6.11 for this repo's test-file-location convention; a shared
// test HELPER module, unlike a test file itself, is not required to live next to what it tests).
//
// Cleanup retries up to 5 times with a short delay: on Windows, a just-closed libSQL client can
// briefly hold a file lock after `client.close()` returns (native binding handle release is not
// perfectly synchronous), which would otherwise fail an unrelated test on a transient `EBUSY`.
// This retry behavior is strictly safer than a single-attempt `rm` -- it can only help cleanup
// succeed, never change what a test actually asserts -- so it is the one canonical implementation
// every caller gets, not an opt-in.
export async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
