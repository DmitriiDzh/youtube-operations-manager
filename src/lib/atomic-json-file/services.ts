import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "@/lib/rename-retry";

/**
 * Shared atomic-write-then-chmod-0600 implementation for small device-local JSON state files
 * (tmp-write -> chmod tmp -> rename -> chmod final). Previously duplicated verbatim between
 * `src/lib/cli-auth/storage.ts` and `src/lib/bootstrap-config/services.ts` (found by
 * independent review, AGENTS.md §D: one implementation per pattern, not two that could drift
 * independently -- e.g. a future Windows-rename-retry-on-EBUSY fix like the one already applied
 * in `src/lib/snapshot/adapters/filesystem.ts` for an analogous issue).
 */
export async function writeJsonFileAtomic(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      await chmod(dir, 0o700);
    } catch {
      // Best effort on an already-existing directory.
    }
  }

  // RISK-25's crash-vs-preexisting-data disambiguation (docs/TECHNICAL_DEBT.md) depends on this
  // write actually surviving a hard crash/power loss, not just a graceful process crash (which
  // a plain writeFile already survives, since the OS page cache outlives the process) --
  // `fsync` (via a real file handle, not writeFile's own auto-closed one) forces the tmp file's
  // content to disk before it is ever renamed into place (independent review, review series
  // cycle 2). Deliberately narrow: this covers the data itself, not the directory entry the
  // rename produces -- full POSIX rename crash-safety would also need an fsync of the
  // directory, which is disproportionate for a single-operator local desktop app.
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  const handle = await open(tmpPath, "w", fsConstants.S_IRUSR | fsConstants.S_IWUSR);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") {
    await chmod(tmpPath, 0o600);
  }

  // RISK-22 (docs/TECHNICAL_DEBT.md): retry on Windows EBUSY/EPERM rather than throwing
  // unhandled on every login/bootstrap-config save that races a transiently-held handle.
  await renameWithRetry(tmpPath, targetPath);

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o600);
  }
}
